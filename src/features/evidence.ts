import * as vscode from "vscode";
import { spawn, ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { AgentSession, AgentStatus } from "../types";
import { AgentStore } from "../store";
import { headCommit, uncommittedDigest } from "../orchestrator/worktree";

/** One command that was run in the agent's worktree. */
export interface EvidenceCheck {
  name: string;
  command: string;
  ok: boolean;
  /** Undefined when the process was killed (timeout/dispose). */
  exitCode?: number;
  durationMs: number;
  /** Tail of interleaved stdout+stderr — enough to see why it failed. */
  outputTail: string;
  timedOut?: boolean;
}

/** Proof record for one settle of a managed agent's worktree. */
export interface EvidenceReport {
  sessionId: string;
  worktreePath: string;
  /** Worktree HEAD when the checks ran — staleness compares against this. */
  atCommit: string;
  /** True when uncommitted changes were present at run time. */
  dirty: boolean;
  /** Fingerprint of the uncommitted content at run time ("" = clean) —
   *  lets staleness distinguish "still dirty, same content" from new edits. */
  dirtyDigest: string;
  startedAt: number;
  finishedAt: number;
  checks: EvidenceCheck[];
  /** All checks passed (and at least one ran). */
  ok: boolean;
  source: "auto" | "config";
}

/** What every surface (tree chip, review pill, land gate, shift report)
 *  should derive from a report — the single pass/total derivation. */
export function summarizeChecks(report: EvidenceReport): {
  ok: boolean;
  passed: number;
  total: number;
} {
  return {
    ok: report.ok,
    passed: report.checks.filter((c) => c.ok).length,
    total: report.checks.length,
  };
}

/** The one place that ranks evidence problems (worst first) so the land gate
 *  and other hosts agree with the Review pill: running > failing > stale.
 *  Returns undefined when the evidence is current, green proof. */
export function evidenceProblem(
  s: { ok: boolean; passed: number; total: number; stale: boolean; running: boolean } | undefined,
): string | undefined {
  if (!s)
    return "no evidence report — checks never ran (no commands detected, approval declined, or the agent hasn't settled). Set mas.evidence.commands to define checks";
  if (s.running) return "checks are still running";
  if (!s.ok) return `checks failing (${s.passed}/${s.total} passed)${s.stale ? ", and the work changed since" : ""}`;
  if (s.stale) return "evidence is stale — the work changed after the checks ran";
  return undefined;
}

/** Host-tunable behavior for the controller. */
export interface EvidenceConfig {
  enabled: boolean;
  /** Explicit commands (trusted, no consent prompt). Empty = auto-detect. */
  commands: string[];
  timeoutSeconds: number;
  /** Fleet-wide cap on sessions being checked at once. */
  maxConcurrent: number;
  /** Feed failing check output back to the agent so it can fix and re-verify. */
  selfRepair: boolean;
  /** Cap on consecutive repair rounds before escalating to the human. */
  maxRepairs: number;
}

/** Side effects + lookups the controller needs, wired by the extension host. */
export interface EvidenceDeps {
  /** Registry lookup — evidence persists under the repo root, which outlives
   *  the worktree. Undefined when the session isn't (or is no longer) managed. */
  resolve(sessionId: string): { repoRoot: string } | undefined;
  /** One-time per-repo approval before AUTO-DETECTED commands ever run —
   *  they are arbitrary code from the worktree's package.json. The host owns
   *  persistence of the decision. */
  consent(repoRoot: string, commands: string[]): Promise<boolean>;
  /** Push a repair prompt into the agent's terminal (exact session map only,
   *  same rule as Unattended's nudge). Returns false when no terminal is live. */
  repair(sessionId: string, prompt: string): boolean;
  notify(message: string): void;
}

interface DetectedCheck {
  name: string;
  command: string;
}

/**
 * Auto-detect verification commands for a worktree. Deliberately conservative:
 * only well-known script names / project files, never a bare `npm install`.
 */
export function detectChecks(dir: string): DetectedCheck[] {
  const checks: DetectedCheck[] = [];
  try {
    const pkgPath = path.join(dir, "package.json");
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      const scripts: Record<string, string> = pkg.scripts || {};
      for (const name of ["typecheck", "lint", "test"]) {
        if (scripts[name]) checks.push({ name, command: `npm run --silent ${name}` });
      }
      const hasTs =
        !!(pkg.dependencies?.typescript || pkg.devDependencies?.typescript) &&
        fs.existsSync(path.join(dir, "tsconfig.json"));
      if (!scripts["typecheck"] && hasTs)
        checks.push({ name: "tsc", command: "npx --no-install tsc --noEmit" });
      return checks;
    }
    if (fs.existsSync(path.join(dir, "Cargo.toml")))
      return [{ name: "cargo check", command: "cargo check" }];
    if (fs.existsSync(path.join(dir, "go.mod")))
      return [
        { name: "go build", command: "go build ./..." },
        { name: "go test", command: "go test ./..." },
      ];
  } catch {
    /* unreadable manifest -> no auto checks */
  }
  return checks;
}

/** Kill a check's whole process tree: process group on POSIX, taskkill /T on
 *  Windows — a plain kill leaves npm's grandchildren holding the pipes. */
function killTree(p: ChildProcess): void {
  try {
    if (!p.pid) return void p.kill();
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(p.pid), "/T", "/F"]);
    } else {
      process.kill(-p.pid, "SIGKILL");
    }
  } catch {
    /* already gone */
  }
}

function isActive(s: AgentStatus): boolean {
  return s === "running" || s === "thinking";
}

function isSettled(s: AgentStatus): boolean {
  return s === "idle" || s === "done";
}

/**
 * Evidence Gates: when a MANAGED agent settles (stops working), run the
 * project's verification commands inside its worktree and keep the results as
 * an evidence report — so "done" arrives with proof, not vibes.
 *
 *   - Only ever runs in worktrees MAS created (same ownership rule as the
 *     Unattended controller). External sessions are never touched.
 *   - Auto-detected commands are gated behind a one-time per-repo consent;
 *     commands the user configured explicitly are trusted. Consent is awaited
 *     OUTSIDE the run slots so an unanswered modal can't starve the queue.
 *   - A settle whose worktree content is byte-identical to the last report
 *     skips the (expensive) re-run and reuses the report.
 *   - Reports persist to <repoRoot>/.agentview/evidence/<sessionId>.json so
 *     they survive worktree cleanup (provenance uses this later).
 */
export class EvidenceController {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  private readonly reports = new Map<string, EvidenceReport>();
  /** Sessions whose persisted report we already looked for on disk. */
  private readonly hydrateTried = new Set<string>();
  private readonly prevStatus = new Map<string, AgentStatus>();
  /** Sessions with a run queued or executing (drives the "checks…" chip). */
  private readonly pending = new Set<string>();
  /** Consecutive failed-report repair rounds per session; reset on green. */
  private readonly repairState = new Map<string, { count: number; escalated: boolean }>();
  private readonly procs = new Set<ChildProcess>();
  /** Per-repo consent, cached as a promise so N agents finishing at once
   *  share one modal instead of stacking N of them. */
  private readonly consentByRepo = new Map<string, Promise<boolean>>();
  /** Slot semaphore for command execution (consent/detection are unslotted). */
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  private sub?: vscode.Disposable;
  private disposed = false;

  constructor(
    private readonly store: AgentStore,
    private readonly getConfig: () => EvidenceConfig,
    private readonly deps: EvidenceDeps,
  ) {}

  start(): void {
    this.sub = this.store.onDidChange(() => this.onChange());
  }

  dispose(): void {
    this.disposed = true;
    this.sub?.dispose();
    for (const p of this.procs) killTree(p);
    this.procs.clear();
    while (this.waiters.length) this.waiters.shift()!();
    this._onDidChange.dispose();
  }

  get(sessionId: string): EvidenceReport | undefined {
    const r = this.reports.get(sessionId);
    if (r) return r;
    // Reports survive window reloads on disk — hydrate lazily (once per
    // session) so a green run isn't forgotten just because the host restarted.
    if (this.hydrateTried.has(sessionId)) return undefined;
    this.hydrateTried.add(sessionId);
    const repoRoot = this.deps.resolve(sessionId)?.repoRoot;
    if (!repoRoot) return undefined;
    try {
      const file = path.join(repoRoot, ".agentview", "evidence", `${sessionId}.json`);
      if (!fs.existsSync(file)) return undefined;
      const rep = JSON.parse(fs.readFileSync(file, "utf8")) as EvidenceReport;
      if (rep && rep.sessionId === sessionId && Array.isArray(rep.checks)) {
        this.reports.set(sessionId, rep);
        return rep;
      }
    } catch {
      /* corrupt/unreadable file -> treat as no report */
    }
    return undefined;
  }

  isRunning(sessionId: string): boolean {
    return this.pending.has(sessionId);
  }

  /** Manual trigger (command palette / row action) — bypasses edge detection
   *  but not ownership, consent, or the concurrency cap. */
  request(sessionId: string): void {
    const a = this.store.getById(sessionId);
    if (!a || a.kind !== "session" || !a.managed || !a.worktreePath) {
      this.deps.notify("Agent View: evidence checks only run for managed worktree agents.");
      return;
    }
    this.enqueue(a, true);
  }

  private onChange(): void {
    const cfg = this.getConfig();
    const live = new Set<string>();
    for (const a of this.store.list()) {
      if (a.kind !== "session") continue;
      live.add(a.sessionId);
      const prev = this.prevStatus.get(a.sessionId);
      this.prevStatus.set(a.sessionId, a.status);
      if (!cfg.enabled || !a.managed || !a.worktreePath) continue;
      // The gate: the agent was working and has now settled. "waiting" is a
      // real ask (notifications own it); a nudged/resumed agent re-arms by
      // passing through "running" again. Duplicate settles are cheap: the
      // unchanged-content check below skips identical re-runs.
      if (prev === undefined || !isActive(prev) || !isSettled(a.status)) continue;
      this.enqueue(a, false);
    }
    // Bounded growth — forget sessions that aged out of discovery.
    for (const id of this.prevStatus.keys()) if (!live.has(id)) this.prevStatus.delete(id);
    for (const id of this.repairState.keys()) if (!live.has(id)) this.repairState.delete(id);
    for (const id of this.reports.keys()) if (!live.has(id)) this.reports.delete(id);
    for (const id of this.hydrateTried) if (!live.has(id)) this.hydrateTried.delete(id);
  }

  private enqueue(a: AgentSession, manual: boolean): void {
    if (this.pending.has(a.sessionId)) return;
    this.pending.add(a.sessionId);
    this._onDidChange.fire();
    void this.runFor(a.sessionId, manual).finally(() => {
      this.pending.delete(a.sessionId);
      this._onDidChange.fire();
    });
  }

  private async runFor(sessionId: string, manual: boolean): Promise<void> {
    const a = this.store.getById(sessionId);
    const wt = a?.worktreePath;
    if (!a || !wt || !fs.existsSync(wt)) return;

    const cfg = this.getConfig();
    const explicit = cfg.commands.filter((c) => c.trim().length > 0);
    const source: EvidenceReport["source"] = explicit.length > 0 ? "config" : "auto";
    const checks: DetectedCheck[] =
      source === "config"
        ? explicit.map((command) => ({ name: command.split(/\s+/).slice(0, 2).join(" "), command }))
        : detectChecks(wt);
    if (checks.length === 0) {
      if (manual)
        this.deps.notify(
          "Agent View: no evidence commands detected in this worktree — set mas.evidence.commands to define them.",
        );
      return;
    }

    const managed = this.deps.resolve(sessionId);
    if (source === "auto") {
      const repoRoot = managed?.repoRoot;
      if (!repoRoot) return;
      // Unslotted on purpose: an unanswered modal must not hold a run slot.
      if (!(await this.consentFor(repoRoot, checks))) return;
    }
    if (this.disposed) return;

    // Identical content since the last report -> reuse it instead of paying
    // for npm again; a red reused report still advances the repair loop.
    const [head, digest] = await Promise.all([
      headCommit(wt).catch(() => ""),
      uncommittedDigest(wt).catch(() => ""),
    ]);
    const existing = this.reports.get(sessionId);
    const sameCommands = existing?.checks.map((c) => c.command).join("\n") === checks.map((c) => c.command).join("\n");
    if (existing && sameCommands && existing.atCommit === head && existing.dirtyDigest === digest) {
      if (!existing.ok) this.maybeRepair(existing);
      return;
    }

    await this.acquireSlot();
    try {
      if (this.disposed || !fs.existsSync(wt)) return;
      const startedAt = Date.now();
      const results: EvidenceCheck[] = [];
      for (const c of checks) {
        if (this.disposed) return;
        results.push(await this.runCommand(c, wt, cfg.timeoutSeconds * 1000));
      }
      // Fingerprint AFTER the run: checks may drop artifacts (coverage/ etc.)
      // into the tree, and staleness must compare against the steady state a
      // reviewer will actually observe — else every report is instantly stale.
      const [headAfter, digestAfter] = await Promise.all([
        headCommit(wt).catch(() => ""),
        uncommittedDigest(wt).catch(() => ""),
      ]);
      const report: EvidenceReport = {
        sessionId,
        worktreePath: wt,
        atCommit: headAfter,
        dirty: digestAfter !== "",
        dirtyDigest: digestAfter,
        startedAt,
        finishedAt: Date.now(),
        checks: results,
        ok: results.length > 0 && results.every((r) => r.ok),
        source,
      };
      this.reports.set(sessionId, report);
      this.persist(report, managed?.repoRoot);
      this._onDidChange.fire();

      if (report.ok) {
        this.repairState.delete(sessionId);
      } else {
        this.maybeRepair(report);
      }
    } finally {
      this.releaseSlot();
    }
  }

  /** Self-repair: hand the failing output back to the agent, capped so a
   *  hopeless failure can't ping-pong forever; past the cap (or with no live
   *  terminal to talk to), escalate to the human exactly once. */
  private maybeRepair(report: EvidenceReport): void {
    const cfg = this.getConfig();
    if (!cfg.selfRepair) return;
    const a = this.store.getById(report.sessionId);
    // Respect the human: dismissed agents are theirs, not the auto-pilot's.
    if (!a || a.acknowledged) return;
    const st = this.repairState.get(report.sessionId) || { count: 0, escalated: false };
    const escalate = (msg: string) => {
      if (!st.escalated) {
        st.escalated = true;
        this.deps.notify(msg);
      }
      this.repairState.set(report.sessionId, st);
    };
    if (st.count >= Math.max(1, cfg.maxRepairs)) {
      escalate(
        `Evidence: ${a.label} still fails its checks after ${st.count} repair round${st.count === 1 ? "" : "s"}. Over to you.`,
      );
      return;
    }
    const failing = report.checks.filter((c) => !c.ok);
    // Single line: Terminal.sendText submits every newline, and a multi-line
    // prompt typed into a dead claude session would execute in the shell.
    const detail = failing
      .map(
        (c) =>
          `${c.command} ${c.timedOut ? "timed out" : `failed (exit ${c.exitCode ?? "killed"})`}: ${c.outputTail.slice(-400).replace(/\s*\n+\s*/g, " · ")}`,
      )
      .join(" | ")
      .slice(0, 1600);
    const prompt = `Verification failed in your worktree — fix these, then re-run the failing commands to confirm: ${detail}`;
    if (this.deps.repair(report.sessionId, prompt)) {
      st.count += 1;
      this.repairState.set(report.sessionId, st);
    } else {
      escalate(
        `Evidence: ${a.label} fails its checks and has no live terminal to self-repair. Over to you.`,
      );
    }
  }

  private consentFor(repoRoot: string, checks: DetectedCheck[]): Promise<boolean> {
    let p = this.consentByRepo.get(repoRoot);
    if (!p) {
      p = this.deps.consent(
        repoRoot,
        checks.map((c) => c.command),
      );
      this.consentByRepo.set(repoRoot, p);
      // An Esc/undecided answer must re-ask next time, not stick as "no".
      void p.then((ok) => {
        if (!ok) this.consentByRepo.delete(repoRoot);
      });
    }
    return p;
  }

  private acquireSlot(): Promise<void> {
    const cap = Math.max(1, this.getConfig().maxConcurrent);
    if (this.active < cap) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(() => {
        this.active++;
        resolve();
      });
    });
  }

  private releaseSlot(): void {
    this.active--;
    this.waiters.shift()?.();
  }

  private runCommand(check: DetectedCheck, cwd: string, timeoutMs: number): Promise<EvidenceCheck> {
    return new Promise((resolve) => {
      const started = Date.now();
      let tail = "";
      let settled = false;
      const append = (chunk: Buffer | string) => {
        tail = (tail + chunk.toString()).slice(-4000);
      };
      const finish = (result: Omit<EvidenceCheck, "name" | "command">) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(graceTimer!);
        this.procs.delete(child);
        resolve({ name: check.name, command: check.command, ...result });
      };
      // CI=1 keeps test runners out of watch mode; stdin is ignored so nothing
      // can sit waiting for input past the timeout. Own process group (POSIX)
      // so timeout/dispose kill npm's grandchildren too, not just the shell.
      const child = spawn(check.command, {
        cwd,
        shell: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, CI: "1", FORCE_COLOR: "0" },
      });
      this.procs.add(child);
      let timedOut = false;
      let graceTimer: NodeJS.Timeout | undefined;
      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
        // Survivors that keep the pipes open must not hang the run forever —
        // force-resolve after a grace period even if 'close' never fires.
        graceTimer = setTimeout(() => {
          finish({
            ok: false,
            durationMs: Date.now() - started,
            outputTail: tail.trim(),
            timedOut: true,
          });
        }, 3000);
      }, timeoutMs);
      child.stdout?.on("data", append);
      child.stderr?.on("data", append);
      child.on("close", (code) => {
        finish({
          ok: code === 0 && !timedOut,
          exitCode: code ?? undefined,
          durationMs: Date.now() - started,
          outputTail: tail.trim(),
          timedOut: timedOut || undefined,
        });
      });
      child.on("error", () => {
        finish({
          ok: false,
          durationMs: Date.now() - started,
          outputTail: tail.trim() || "failed to start",
        });
      });
    });
  }

  private persist(report: EvidenceReport, repoRoot: string | undefined): void {
    if (!repoRoot) return;
    try {
      const dir = path.join(repoRoot, ".agentview", "evidence");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${report.sessionId}.json`), JSON.stringify(report, null, 2));
    } catch {
      /* persistence is best-effort; the in-memory report still drives the UI */
    }
  }
}

/** Human-readable report for the "Show Evidence" command. */
export function formatEvidenceReport(report: EvidenceReport, label: string): string {
  const lines: string[] = [];
  const verdict = report.ok ? "all checks passed" : "checks FAILED";
  lines.push(`# Evidence — ${label}`);
  lines.push("");
  lines.push(`**${verdict}** · ran ${new Date(report.finishedAt).toLocaleString()}`);
  lines.push("");
  lines.push(`- Worktree: \`${report.worktreePath}\``);
  lines.push(`- Commit: \`${report.atCommit.slice(0, 12) || "unknown"}\`${report.dirty ? " (uncommitted changes present)" : ""}`);
  lines.push(`- Commands: ${report.source === "config" ? "configured (mas.evidence.commands)" : "auto-detected"}`);
  lines.push("");
  for (const c of report.checks) {
    const status = c.ok ? "pass" : c.timedOut ? "TIMED OUT" : `FAIL (exit ${c.exitCode ?? "killed"})`;
    lines.push(`## ${c.name} — ${status} · ${(c.durationMs / 1000).toFixed(1)}s`);
    lines.push("");
    lines.push(`\`${c.command}\``);
    if (c.outputTail) {
      lines.push("");
      lines.push("```");
      lines.push(c.outputTail);
      lines.push("```");
    }
    lines.push("");
  }
  return lines.join("\n");
}
