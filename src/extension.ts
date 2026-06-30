import * as vscode from "vscode";
import { AgentStore } from "./store";
import { Registry, ManagedAgent } from "./orchestrator/registry";
import { spawnAgent, SpawnConfig } from "./orchestrator/spawn";
import { spawnRace, FanoutBatch, cleanupGroup } from "./orchestrator/groups";
import { terminals } from "./orchestrator/terminals";
import {
  worktreeDiff,
  currentRef,
  isGitRepo,
  repoRoot,
  headCommit,
  removeWorktree,
  reviewDiffStat,
  hasUncommittedChanges,
  isWorkingTreeClean,
  isMergeInProgress,
  commitAll,
  squashMergeBranch,
  resetHard,
  defaultRemote,
  pushBranch,
  remoteWebUrl,
} from "./orchestrator/worktree";
import * as path from "path";
import { execFile } from "child_process";
import { BaseContentProvider, openReviewDiff, BASE_SCHEME, DiffResolver } from "./review/diff";
import { ReviewStore } from "./review/store";
import { ReviewItem, ReviewQueue } from "./webview/protocol";
import { BoardStore } from "./board/store";
import { BoardPanel, BoardDeps, CapturedDiff } from "./board/panel";
import { buildTeamSnapshot } from "./teams/discover";
import { AgentsProvider } from "./tree/agentsProvider";
import { DetailViewProvider, WebviewHandlers } from "./webview/provider";
import { RaceGroup, RaceCandidate } from "./webview/protocol";
import { HookServer } from "./hooks/server";
import { installHooks, removeHooks, hooksInstalled } from "./hooks/installer";
import { InsightsController } from "./features/insights";
import { requireLlmConsent } from "./features/consent";
import { runMergeAdvisor } from "./features/mergeAdvisor";
import { NotificationController } from "./features/notifications";
import { UnattendedController, UnattendedConfig } from "./features/unattended";
import { parseChecklist } from "./util/checklist";
import { humanizeTool, truncate } from "./util/format";
import { AgentSession } from "./types";
import { readMessages } from "./transcript";

function cfg() {
  return vscode.workspace.getConfiguration("mas");
}

function spawnConfig(): SpawnConfig {
  const c = cfg();
  // In unattended mode, spawn agents that auto-accept edits but still prompt for
  // Bash (which escalates to "waiting" -> a notification), so a stray destructive
  // command never runs unattended.
  const unattended = c.get<boolean>("unattended.enabled", false);
  const acceptEdits = c.get<boolean>("unattended.autoAcceptEdits", true);
  return {
    claudePath: c.get<string>("claudePath", "claude"),
    defaultModel: c.get<string>("defaultModel", ""),
    worktreeRoot: c.get<string>("worktreeRoot", ".mas/worktrees"),
    spawnExtraFlags: c.get<string[]>("spawnExtraFlags", []),
    permissionMode: unattended && acceptEdits ? "acceptEdits" : undefined,
  };
}

function defaultCwd(): string | undefined {
  return (
    (vscode.window.activeTextEditor &&
      vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri)?.uri.fsPath) ||
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  );
}

function sessionIdOf(arg: AgentSession | string | undefined): string | undefined {
  if (!arg) return undefined;
  return typeof arg === "string" ? arg : arg.sessionId;
}

export function activate(context: vscode.ExtensionContext): void {
  const registry = new Registry(context.globalState);
  const store = new AgentStore(registry, () => ({
    recentDays: cfg().get<number>("recentDays", 7),
    recentHours: cfg().get<number>("recentHours", 24),
  }));

  // Race state held by the host (the webview renders it; the store drives live
  // status/tokens, these maps add the human-only bits).
  const raceScores = new Map<string, { score: number; recommended: boolean }>();
  const raceWinner = new Map<string, string>(); // groupId -> winning sessionId
  const activeBatches = new Set<FanoutBatch>();
  let boardStore: BoardStore | undefined;

  // Review & Land state: the resolved diff base per session (so the virtual
  // base-content provider matches the file list), and a one-shot `gh` probe.
  const SNAPSHOT_MSG = "Agent View: review snapshot";
  const reviewBaseCache = new Map<string, string>();
  let reviewBuilding = false;
  let lastReviewQueue: ReviewQueue | undefined;
  let ghAvailableCache: Promise<boolean> | undefined;
  function ghAvailable(): Promise<boolean> {
    if (!ghAvailableCache) {
      const ghPath = cfg().get<string>("review.ghPath", "gh");
      ghAvailableCache = new Promise<boolean>((resolve) => {
        execFile(ghPath, ["--version"], { timeout: 5000 }, (err) => resolve(!err));
      });
    }
    return ghAvailableCache;
  }
  // Re-probe `gh` if the configured path changes mid-session, and keep the
  // unattended context + status-bar cost meter in sync when settings change.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("mas.review.ghPath")) ghAvailableCache = undefined;
      if (e.affectsConfiguration("mas.unattended") || e.affectsConfiguration("mas.statusBar.enabled")) {
        vscode.commands.executeCommand("setContext", "mas.unattended", unattendedConfig().enabled);
        updatePulse();
      }
    }),
  );

  /** The agent's fork-point commit — an immutable SHA, never a moving branch
   *  name (the diff base must not drift while you review). */
  async function resolveBase(m: ManagedAgent): Promise<string> {
    return m.baseRef || (await headCommit(m.repoRoot)) || (await currentRef(m.repoRoot));
  }

  // --- New-agent flow (shared by command + webview button) ---
  async function runNewAgent(): Promise<void> {
    const cwd = defaultCwd();
    if (!cwd) {
      vscode.window.showErrorMessage("Agent View: open a folder/workspace first.");
      return;
    }
    const task = await vscode.window.showInputBox({
      title: "New Claude Code Agent",
      prompt: "Initial task for the agent (leave empty to start an interactive session)",
      placeHolder: "e.g. Refactor the auth module and add tests",
    });
    if (task === undefined) return; // cancelled

    const wtPick = await vscode.window.showQuickPick(
      [
        { label: "$(git-branch) Isolated worktree", description: "new branch, conflict-free", val: true },
        { label: "$(folder) Current directory", description: "run in place", val: false },
      ],
      { title: "Where should the agent run?" },
    );
    if (!wtPick) return;

    try {
      const res = await spawnAgent(
        { cwd, task: task || undefined, useWorktree: wtPick.val },
        registry,
        spawnConfig(),
      );
      vscode.window.showInformationMessage(
        `Agent View: spawned agent on ${res.branch}${wtPick.val ? ` (${res.worktreePath})` : ""}`,
      );
      setTimeout(() => store.refresh(), 800);
    } catch (e: any) {
      vscode.window.showErrorMessage(`Agent View: failed to spawn agent — ${e.message}`);
    }
  }

  // --- Diff helper (shared by command, notification button, race view) ---
  async function openDiffFor(id: string, column?: vscode.ViewColumn): Promise<void> {
    const managed = registry.get(id);
    if (!managed?.worktreePath) {
      vscode.window.showWarningMessage("Agent View: diff is only available for managed worktree agents.");
      return;
    }
    // The recorded fork point gives a stable diff even if the repo's branch
    // moved since spawn; fall back to the current ref for older entries.
    const base = await resolveBase(managed);
    const diff = await worktreeDiff(managed.worktreePath, base);
    const doc = await vscode.workspace.openTextDocument({
      content: diff || "(no changes yet)",
      language: "diff",
    });
    await vscode.window.showTextDocument(doc, { preview: true, viewColumn: column });
  }

  // --- Pinboard (canvas) ---
  async function captureDiff(sessionId: string): Promise<CapturedDiff | null> {
    const m = registry.get(sessionId);
    if (!m?.worktreePath) return null;
    const base = await resolveBase(m);
    const diffText = await worktreeDiff(m.worktreePath, base);
    const commit = await headCommit(m.worktreePath);
    return { diffText, branch: m.branch, commit, baseRef: base, label: m.label };
  }

  // External (non-managed) agents have no worktree to diff, so the Pinboard
  // pins their latest message instead.
  function captureAgentOutput(sessionId: string): { title: string; body: string } | null {
    const a = store.getById(sessionId);
    if (!a) return null;
    const msgs = readMessages(a.jsonlPath);
    let body = "";
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === "assistant" && msgs[i].text.trim()) {
        body = msgs[i].text;
        break;
      }
    }
    if (!body) {
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].text.trim()) {
          body = msgs[i].text;
          break;
        }
      }
    }
    if (!body) body = a.lastAction || a.label || "(no output yet)";
    return { title: a.label || a.sessionId.slice(0, 8), body: body.slice(0, 6000) };
  }

  function sendBoardSelectionToAgent(sessionId: string, summary: string): void {
    const a = store.getById(sessionId);
    const name = `Claude Code ${a?.gitBranch || registry.get(sessionId)?.branch || ""}`.trim();
    const prompt =
      `The user selected Pinboard cards for you (${summary}). ` +
      `Read .agentview/board/selection.json (also at $AGENTVIEW_BOARD_DIR/selection.json) for the full details and act on them; ` +
      `post any result by writing .agentview/board/inbox/<id>.json — see .agentview/board/README.md.`;
    const ok = terminals.sendText(sessionId, prompt, name);
    if (ok) {
      vscode.window.showInformationMessage("Pinboard: sent your selection to the agent.");
    } else {
      vscode.window.showWarningMessage(
        "Pinboard: no live terminal for that agent (it may be external or closed). Your selection was saved to .agentview/board/selection.json.",
      );
    }
  }

  async function openCanvas(): Promise<void> {
    const cwd = defaultCwd();
    if (!cwd) {
      vscode.window.showErrorMessage("Agent View: open a folder/workspace first.");
      return;
    }
    const root = (await isGitRepo(cwd)) ? await repoRoot(cwd).catch(() => cwd) : cwd;
    const dir = path.join(root, ".agentview", "board");
    if (!boardStore || boardStore.dir !== dir) {
      boardStore?.dispose();
      boardStore = new BoardStore(root);
    }
    const deps: BoardDeps = {
      focusAgent: (id) => {
        vscode.commands.executeCommand("mas.detail.focus");
        detail.select(id);
      },
      openDiff: (id) =>
        openDiffFor(id).catch((e) => vscode.window.showErrorMessage(`Agent View: diff failed — ${e.message}`)),
      newAgent: runNewAgent,
      captureDiff,
      captureOutput: captureAgentOutput,
      sendToAgent: sendBoardSelectionToAgent,
      hooksReady: () => hooksInstalled(),
      buildTeams: () => buildTeamSnapshot(store),
    };
    BoardPanel.createOrShow(context.extensionUri, store, boardStore, deps);
  }

  // --- Agent Race orchestration ---
  function buildRace(groupId: string): RaceGroup | null {
    const members = registry.byGroup(groupId);
    if (members.length === 0) return null;
    const task = members.find((m) => m.task)?.task || "";
    const candidates: RaceCandidate[] = members
      .slice()
      .sort((a, b) => a.branch.localeCompare(b.branch))
      .map((m, i): RaceCandidate => {
        const a = store.getById(m.sessionId);
        const sc = raceScores.get(m.sessionId);
        const t = a?.tokens;
        return {
          sessionId: m.sessionId,
          index: i,
          label: a?.label || m.label,
          status: a?.status || "unknown",
          tokensTotal: t ? t.input + t.output + t.cacheRead + t.cacheCreate : 0,
          branch: m.branch,
          liveAction: a?.liveAction,
          lastAction: a?.lastAction,
          score: sc?.score,
          recommended: sc?.recommended,
        };
      });
    return {
      groupId,
      task,
      candidates,
      winnerId: raceWinner.get(groupId),
      ranked: candidates.some((c) => typeof c.score === "number"),
    };
  }

  async function pickWinner(sessionId: string): Promise<void> {
    const m = registry.get(sessionId);
    if (!m) return;
    if (m.groupId) raceWinner.set(m.groupId, sessionId);
    detail.refreshRace();
    try {
      await openDiffFor(sessionId);
    } catch {
      /* diff is best-effort here */
    }
    const mergeCmd = `git merge ${m.branch}`;
    await vscode.env.clipboard.writeText(mergeCmd);
    let base = "the base branch";
    try {
      base = await currentRef(m.repoRoot);
    } catch {
      /* ignore */
    }
    vscode.window.showInformationMessage(
      `Winner: ${m.label || m.branch}. Copied \`${mergeCmd}\` — run it from ${base} to merge.`,
    );
  }

  async function openAllDiffs(groupId: string): Promise<void> {
    const members = registry.byGroup(groupId).filter((m) => m.worktreePath);
    const cols = [vscode.ViewColumn.One, vscode.ViewColumn.Two, vscode.ViewColumn.Three];
    let i = 0;
    for (const m of members) {
      try {
        await openDiffFor(m.sessionId, cols[Math.min(i, cols.length - 1)]);
      } catch {
        /* skip a candidate whose diff fails */
      }
      i++;
    }
  }

  async function rankRace(groupId: string): Promise<void> {
    const members = registry.byGroup(groupId);
    const agents = members
      .map((m) => store.getById(m.sessionId))
      .filter((a): a is AgentSession => !!a && a.managed);
    if (agents.length < 2) {
      vscode.window.showWarningMessage("Race ranking needs at least 2 candidates.");
      return;
    }
    if (!(await requireLlmConsent(context))) return;
    const c = cfg();
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Race: ranking candidates…" },
      async () => {
        try {
          const { rankings } = await runMergeAdvisor(
            agents,
            registry,
            c.get<string>("claudePath", "claude"),
            c.get<string>("insights.mergeModel", "claude-sonnet-4-6"),
          );
          for (const m of members) raceScores.delete(m.sessionId);
          rankings.forEach((r, i) => raceScores.set(r.sessionId, { score: r.score, recommended: i === 0 }));
          detail.refreshRace();
        } catch (e: any) {
          vscode.window.showErrorMessage(`Race ranking: ${e.message}`);
        }
      },
    );
  }

  async function cleanupRace(groupId: string): Promise<void> {
    const members = registry.byGroup(groupId);
    if (members.length === 0) {
      detail.clearRace();
      return;
    }
    const winnerId = raceWinner.get(groupId);
    const items = winnerId ? ["Clean up all", "Keep winner, clean rest"] : ["Clean up"];
    const pick = await vscode.window.showWarningMessage(
      `Clean up ${members.length} race worktree${members.length === 1 ? "" : "s"}? ` +
        `The worktree checkouts are removed (branches are kept); uncommitted changes in them are discarded.`,
      { modal: true },
      ...items,
    );
    if (!pick) return;
    const keepSessionId = pick === "Keep winner, clean rest" ? winnerId : undefined;
    const { removed, errors } = await cleanupGroup(groupId, registry, { keepSessionId });
    if (!keepSessionId) raceWinner.delete(groupId);
    for (const m of members) {
      if (m.sessionId !== keepSessionId) raceScores.delete(m.sessionId);
    }
    store.refresh();
    if (keepSessionId) detail.refreshRace();
    else detail.clearRace();
    vscode.window.showInformationMessage(
      `Agent View: removed ${removed} worktree${removed === 1 ? "" : "s"}.` +
        (errors.length ? ` Errors: ${errors.join("; ")}` : ""),
    );
  }

  // --- Review & Land ---
  // The virtual scheme that serves each file's base-commit contents, so the
  // review can render a real side-by-side diff (base vs the live worktree file).
  const reviewDiffResolver: DiffResolver = (sid) => {
    const mm = registry.get(sid);
    if (!mm?.worktreePath) return undefined;
    const aa = store.getById(sid);
    return {
      worktreePath: mm.worktreePath,
      // Prefer the SHA pinned by openReviewDiffFor; never a moving branch name.
      // Empty is fine — showFileAtRef treats it as "no base", so the file simply
      // renders as fully added rather than against the wrong commit.
      baseRef: reviewBaseCache.get(sid) || mm.baseRef || "",
      label: aa?.label || mm.label || sid.slice(0, 8),
    };
  };
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      BASE_SCHEME,
      new BaseContentProvider(reviewDiffResolver),
    ),
  );

  async function buildReviewQueue(): Promise<ReviewQueue> {
    // Coalesce overlapping builds (each spawns git per agent); a refresh that
    // arrives mid-build reuses the last snapshot instead of piling on.
    if (reviewBuilding && lastReviewQueue) return lastReviewQueue;
    reviewBuilding = true;
    try {
      return await computeReviewQueue();
    } finally {
      reviewBuilding = false;
    }
  }

  async function computeReviewQueue(): Promise<ReviewQueue> {
    const c = cfg();
    const allowLand = c.get<boolean>("review.allowLand", false);
    const gh = await ghAvailable();
    const managed = store.list().filter((a) => a.managed && a.kind === "session");
    const items: ReviewItem[] = [];
    for (const a of managed) {
      const m = registry.get(a.sessionId);
      if (!m?.worktreePath) continue;
      let stat = { files: 0, additions: 0, deletions: 0 };
      let uncommitted = false;
      try {
        const base = await resolveBase(m);
        stat = await reviewDiffStat(m.worktreePath, base);
        uncommitted = await hasUncommittedChanges(m.worktreePath);
      } catch {
        /* worktree may have been removed — show it with zeroed stats */
      }
      const t = a.tokens;
      items.push({
        sessionId: a.sessionId,
        label: a.label || m.label,
        branch: m.branch,
        status: a.status,
        files: stat.files,
        additions: stat.additions,
        deletions: stat.deletions,
        hasUncommitted: uncommitted,
        plan: a.plan,
        lastError: a.lastError,
        groupId: m.groupId,
        groupRole: m.groupRole,
        tokensTotal: t.input + t.output + t.cacheRead + t.cacheCreate,
        lastActivity: a.lastActivity,
      });
    }
    items.sort((x, y) => y.lastActivity - x.lastActivity);
    lastReviewQueue = { items, allowLand, ghAvailable: gh };
    return lastReviewQueue;
  }

  async function openReviewDiffFor(sessionId: string): Promise<void> {
    const m = registry.get(sessionId);
    if (!m?.worktreePath) {
      vscode.window.showWarningMessage(
        "Agent View: review diff is only available for Agent View-spawned worktree agents.",
      );
      return;
    }
    const base = await resolveBase(m);
    reviewBaseCache.set(sessionId, base);
    const a = store.getById(sessionId);
    const label = a?.label || m.label || sessionId.slice(0, 8);
    const maxFiles = Math.max(1, cfg().get<number>("review.maxDiffFiles", 20));
    const total = await openReviewDiff(
      sessionId,
      { worktreePath: m.worktreePath, baseRef: base, label },
      maxFiles,
    );
    if (total === 0) {
      vscode.window.showInformationMessage(`Agent View: ${label} has no changes yet.`);
    } else if (total > maxFiles) {
      vscode.window.showInformationMessage(
        `Agent View: showing the first ${maxFiles} of ${total} changed files.`,
      );
    }
  }

  function requestChanges(sessionId: string, comment: string): void {
    const text = (comment || "").trim();
    if (!text) return;
    const m = registry.get(sessionId);
    const a = store.getById(sessionId);
    const root = m?.repoRoot || defaultCwd();
    if (!root) {
      vscode.window.showErrorMessage("Agent View: open a folder/workspace first.");
      return;
    }
    let rel: string;
    try {
      rel = new ReviewStore(root).writeComment(sessionId, text, m?.branch);
    } catch (e: any) {
      vscode.window.showErrorMessage(`Agent View: could not save review note — ${e.message}`);
      return;
    }
    const prompt =
      `Review feedback on your changes${m?.branch ? ` (branch ${m.branch})` : ""}: ` +
      `"${truncate(text, 240)}". Full note in ${rel}. Please revise accordingly.`;
    const name = `Claude Code ${a?.gitBranch || m?.branch || ""}`.trim();
    const ok = terminals.sendText(sessionId, prompt, name);
    if (ok) {
      vscode.window.showInformationMessage("Agent View: sent your review feedback to the agent.");
    } else {
      vscode.window.showWarningMessage(
        `Agent View: no live terminal for that agent — feedback saved to ${rel}.`,
      );
    }
  }

  async function copyMerge(sessionId: string): Promise<void> {
    const m = registry.get(sessionId);
    if (!m) return;
    const cmd = `git merge ${m.branch}`;
    await vscode.env.clipboard.writeText(cmd);
    let base = "the base branch";
    try {
      base = await currentRef(m.repoRoot);
    } catch {
      /* ignore */
    }
    vscode.window.showInformationMessage(
      `Agent View: copied \`${cmd}\` — run it from ${base} to merge.`,
    );
  }

  async function landAgent(sessionId: string): Promise<void> {
    if (!cfg().get<boolean>("review.allowLand", false)) {
      vscode.window.showWarningMessage(
        "Agent View: landing is off. Enable mas.review.allowLand to squash-merge from the panel.",
      );
      return;
    }
    const m = registry.get(sessionId);
    if (!m?.worktreePath) {
      vscode.window.showWarningMessage(
        "Agent View: landing is only available for Agent View-spawned worktree agents.",
      );
      return;
    }
    const a = store.getById(sessionId);
    const label = a?.label || m.label || m.branch;
    // P0-2: never merge into a dirty or mid-merge base working tree.
    if (await isMergeInProgress(m.repoRoot)) {
      vscode.window.showErrorMessage(
        "Agent View: the base repo is mid-merge/rebase. Finish that first, then land.",
      );
      return;
    }
    if (!(await isWorkingTreeClean(m.repoRoot))) {
      const pick = await vscode.window.showWarningMessage(
        "Agent View: your working tree has uncommitted changes, so a squash-merge could entangle them. " +
          "Commit or stash them first, or copy the merge command to run yourself.",
        "Copy merge command",
      );
      if (pick === "Copy merge command") await copyMerge(sessionId);
      return;
    }
    const baseBranch = await currentRef(m.repoRoot).catch(() => "the base branch");
    const confirm = await vscode.window.showWarningMessage(
      `Squash-merge ${m.branch} into ${baseBranch}? This commits to your working tree. You can undo before pushing.`,
      { modal: true },
      "Squash-merge",
    );
    if (confirm !== "Squash-merge") return;

    // P0-2 (TOCTOU): the modal blocked for an unbounded time, during which the
    // user could have dirtied the base or started a merge elsewhere. Re-verify
    // immediately before we touch it — the pre-modal checks are only advisory.
    if ((await isMergeInProgress(m.repoRoot)) || !(await isWorkingTreeClean(m.repoRoot))) {
      vscode.window.showErrorMessage(
        "Agent View: the base repo changed (now dirty or mid-merge) — land aborted. Land again from a clean tree.",
      );
      return;
    }
    // Capture the pre-merge head BEFORE any mutation; without it we can't
    // guarantee a safe restore, so refuse rather than risk an unrecoverable state.
    const preHead = await headCommit(m.repoRoot);
    if (!preHead) {
      vscode.window.showErrorMessage("Agent View: could not read the base HEAD — land aborted.");
      return;
    }

    // P0-1: snapshot uncommitted agent work so what was reviewed is what lands.
    // If the snapshot can't be made (commit hook, missing git identity, …), abort
    // rather than silently land stale work.
    if (await hasUncommittedChanges(m.worktreePath)) {
      await commitAll(m.worktreePath, SNAPSHOT_MSG);
      if (await hasUncommittedChanges(m.worktreePath)) {
        vscode.window.showErrorMessage(
          "Agent View: could not snapshot the agent's uncommitted work (a commit hook or missing git identity may be blocking it) — land aborted.",
        );
        return;
      }
    }
    const res = await squashMergeBranch(m.repoRoot, m.branch);
    if (!res.ok) {
      await resetHard(m.repoRoot, preHead); // restore the tree exactly as before
      vscode.window.showErrorMessage(
        res.conflict
          ? `Agent View: ${m.branch} conflicts with ${baseBranch}; nothing was merged. Resolve it manually.`
          : `Agent View: merge failed — ${res.message || "unknown error"}.`,
      );
      return;
    }
    if (res.noChanges) {
      vscode.window.showInformationMessage(
        `Agent View: ${label} has nothing new to land — already merged into ${baseBranch}.`,
      );
      return;
    }
    const mergeHead = await headCommit(m.repoRoot);
    store.refresh();
    const choice = await vscode.window.showInformationMessage(
      `Agent View: landed ${label} into ${baseBranch}.`,
      "Undo",
    );
    if (choice === "Undo") {
      const now = await headCommit(m.repoRoot);
      if (now !== mergeHead) {
        vscode.window.showWarningMessage(
          "Agent View: the repo moved since the merge — undo skipped to avoid losing newer work.",
        );
      } else {
        await resetHard(m.repoRoot, preHead);
        store.refresh();
        vscode.window.showInformationMessage(`Agent View: undid the merge of ${m.branch}.`);
      }
    }
  }

  async function openPrFor(sessionId: string): Promise<void> {
    const m = registry.get(sessionId);
    if (!m?.worktreePath) {
      vscode.window.showWarningMessage(
        "Agent View: PRs are only available for Agent View-spawned worktree agents.",
      );
      return;
    }
    // Only committed work goes into a PR — offer to snapshot first, and abort if
    // the snapshot can't be made (don't push a stale/partial branch).
    if (await hasUncommittedChanges(m.worktreePath)) {
      const pick = await vscode.window.showWarningMessage(
        `${m.branch} has uncommitted changes. Commit them before opening a PR?`,
        { modal: true },
        "Commit & continue",
      );
      if (pick !== "Commit & continue") return;
      await commitAll(m.worktreePath, SNAPSHOT_MSG);
      if (await hasUncommittedChanges(m.worktreePath)) {
        vscode.window.showErrorMessage(
          "Agent View: could not commit the agent's changes (a commit hook or missing git identity may be blocking it) — PR aborted.",
        );
        return;
      }
    }
    const remote = await defaultRemote(m.repoRoot);
    if (!remote) {
      vscode.window.showWarningMessage("Agent View: no git remote is configured to push to.");
      return;
    }
    // The PR base is the branch you'd merge into (the repo's current branch).
    const baseBranch = await currentRef(m.repoRoot).catch(() => "");
    const gh = await ghAvailable();
    // P0-5: pushing publishes code — confirm the outward-facing action first.
    const confirm = await vscode.window.showWarningMessage(
      `Push ${m.branch} to ${remote}${baseBranch ? ` and open a PR into ${baseBranch}` : ""}? This publishes your code.`,
      { modal: true },
      gh ? "Push & open PR" : "Push & copy link",
    );
    if (!confirm) return;
    const pushed = await pushBranch(m.repoRoot, m.branch, remote);
    if (!pushed.ok) {
      vscode.window.showErrorMessage(`Agent View: push failed — ${pushed.message || "unknown error"}.`);
      return;
    }
    // Used when gh is absent, and as a fallback when gh fails AFTER a successful
    // push — the publish already happened, so keep it actionable.
    const copyCompareLink = async (): Promise<void> => {
      const web = await remoteWebUrl(m.repoRoot, remote);
      const compare = !web
        ? ""
        : baseBranch
          ? `${web}/compare/${encodeURIComponent(baseBranch)}...${encodeURIComponent(m.branch)}?expand=1`
          : `${web}/compare/${encodeURIComponent(m.branch)}?expand=1`;
      if (compare) {
        await vscode.env.clipboard.writeText(compare);
        const open = await vscode.window.showInformationMessage(
          `Agent View: pushed ${m.branch}. Copied the PR compare link.`,
          "Open in browser",
        );
        if (open === "Open in browser") vscode.env.openExternal(vscode.Uri.parse(compare));
      } else {
        vscode.window.showInformationMessage(
          `Agent View: pushed ${m.branch}. Open a pull request on your git host.`,
        );
      }
    };
    if (!gh) {
      await copyCompareLink();
      return;
    }
    try {
      const url = await runGhPrCreate(m.repoRoot, m.branch, baseBranch);
      const open = await vscode.window.showInformationMessage(
        `Agent View: opened a PR for ${m.branch}.`,
        "Open in browser",
      );
      if (open === "Open in browser" && url) vscode.env.openExternal(vscode.Uri.parse(url));
    } catch (e: any) {
      vscode.window.showWarningMessage(
        `Agent View: gh pr create failed (${e.message}) — falling back to a compare link.`,
      );
      await copyCompareLink();
    }
  }

  function runGhPrCreate(cwd: string, branch: string, base: string): Promise<string> {
    const ghPath = cfg().get<string>("review.ghPath", "gh");
    const args = ["pr", "create", "--head", branch, "--fill"];
    if (base) args.push("--base", base);
    return new Promise<string>((resolve, reject) => {
      execFile(
        ghPath,
        args,
        { cwd, timeout: 120_000 },
        (err, stdout, stderr) => {
          const out = `${stdout || ""}${stderr || ""}`;
          const url = out.match(/https?:\/\/\S+/);
          if (err) {
            // gh exits non-zero when a PR already exists, but prints its URL.
            if (url) return resolve(url[0]);
            return reject(new Error((stderr || err.message).toString().split("\n")[0]));
          }
          resolve(url ? url[0] : "");
        },
      );
    });
  }

  async function cleanupAgent(sessionId: string): Promise<void> {
    const m = registry.get(sessionId);
    if (!m?.worktreePath) return;
    const confirm = await vscode.window.showWarningMessage(
      `Remove the worktree for ${m.label || m.branch}? The branch ${m.branch} is kept; ` +
        `uncommitted changes in the worktree are discarded.`,
      { modal: true },
      "Remove worktree",
    );
    if (confirm !== "Remove worktree") return;
    try {
      await removeWorktree(m.repoRoot, m.worktreePath);
    } catch (e: any) {
      vscode.window.showErrorMessage(`Agent View: could not remove worktree — ${e.message}`);
      return;
    }
    reviewBaseCache.delete(sessionId);
    await registry.remove(sessionId);
    store.refresh();
    vscode.window.showInformationMessage(`Agent View: removed worktree for ${m.branch} (branch kept).`);
  }

  // --- Fan-out orchestration ---
  async function runFanOut(text: string): Promise<void> {
    const cwd = defaultCwd();
    if (!cwd) {
      vscode.window.showErrorMessage("Agent View: open a folder/workspace first.");
      return;
    }
    const tasks = parseChecklist(text);
    if (tasks.length === 0) {
      vscode.window.showWarningMessage("Fan-out: no tasks found in that text.");
      return;
    }
    const c = cfg();
    const useWorktree = c.get<boolean>("fanout.useWorktree", true);
    if (useWorktree && !(await isGitRepo(cwd))) {
      vscode.window.showWarningMessage(
        "Fan-out: this folder isn't a git repo, so agents can't run in isolated worktrees. Disable mas.fanout.useWorktree to run them in place.",
      );
      return;
    }
    const max = Math.max(1, c.get<number>("fanout.maxConcurrent", 4));
    const confirm = await vscode.window.showInformationMessage(
      `Fan-out ${tasks.length} task${tasks.length === 1 ? "" : "s"} into ${tasks.length} agent${tasks.length === 1 ? "" : "s"}` +
        ` (up to ${max} running at once)?`,
      { modal: true },
      "Spawn",
    );
    if (confirm !== "Spawn") return;

    const batch = new FanoutBatch(
      { cwd, tasks: tasks.map((t) => ({ task: t })), useWorktree, maxConcurrent: max },
      registry,
      spawnConfig(),
      store,
      (info) => {
        if (info.done) activeBatches.delete(batch);
      },
    );
    activeBatches.add(batch);
    try {
      await batch.start();
    } catch (e: any) {
      vscode.window.showErrorMessage(`Fan-out: ${e.message}`);
    }
    nudgeHooksForLive();
    setTimeout(() => store.refresh(), 800);
    void vscode.window
      .showInformationMessage(
        `Fan-out started: ${tasks.length} agent${tasks.length === 1 ? "" : "s"} (${max} at a time).`,
        "Open Pinboard",
      )
      .then((pick) => {
        if (pick === "Open Pinboard") vscode.commands.executeCommand("mas.openCanvas");
      });
  }

  function nudgeHooksForLive(): void {
    if (hooksInstalled()) return;
    vscode.window
      .showInformationMessage(
        "Agent View: install hooks for live progress of these agents?",
        "Configure Hooks",
        "Not now",
      )
      .then((pick) => {
        if (pick === "Configure Hooks") vscode.commands.executeCommand("mas.configureHooks");
      });
  }

  // --- Insights (Conflict Radar + Attention Router) ---
  const insights = new InsightsController(store, context, () => {
    const c = cfg();
    return {
      conflictRadar: c.get<boolean>("conflictRadar.enabled", false),
      attentionRouter: c.get<boolean>("attentionRouter.enabled", false),
      claudePath: c.get<string>("claudePath", "claude"),
      triageModel: c.get<string>("insights.triageModel", "claude-haiku-4-5"),
    };
  });

  // --- Providers ---
  const tree = new AgentsProvider(store);
  const treeView = vscode.window.createTreeView("mas.agents", { treeDataProvider: tree });

  // Surface how the recency window is filtering the list.
  function updateTreeMessage(): void {
    if (store.showingOlder) {
      treeView.message = `Showing all agents (last ${cfg().get<number>("recentDays", 7)}d). Toggle to hide older.`;
    } else {
      const hidden = store.hiddenCount();
      treeView.message =
        hidden > 0
          ? `Showing last ${cfg().get<number>("recentHours", 24)}h · ${hidden} older hidden — use "Show Older Agents".`
          : undefined;
    }
  }
  context.subscriptions.push(store.onDidChange(updateTreeMessage));

  const reportErr = (e: any) => vscode.window.showErrorMessage(`Agent View: ${e?.message || e}`);
  const webviewHandlers: WebviewHandlers = {
    newAgent: runNewAgent,
    pickWinner: (id) => void pickWinner(id).catch(reportErr),
    openCandidateDiff: (id) =>
      openDiffFor(id).catch((e) => vscode.window.showErrorMessage(`Agent View: diff failed — ${e.message}`)),
    openAllDiffs: (gid) => void openAllDiffs(gid).catch(reportErr),
    rankRace: (gid) => void rankRace(gid).catch(reportErr),
    cleanupRace: (gid) => void cleanupRace(gid).catch(reportErr),
    fanOut: (txt) => void runFanOut(txt).catch(reportErr),
    buildRace,
    buildReviewQueue,
    openReviewDiff: (id) =>
      openReviewDiffFor(id).catch((e) =>
        vscode.window.showErrorMessage(`Agent View: review diff failed — ${e.message}`),
      ),
    requestChanges: (id, c) => {
      try {
        requestChanges(id, c);
      } catch (e) {
        reportErr(e);
      }
    },
    landAgent: (id) => void landAgent(id).catch(reportErr),
    openPR: (id) => void openPrFor(id).catch(reportErr),
    copyMerge: (id) => void copyMerge(id).catch(reportErr),
    cleanupAgent: (id) => void cleanupAgent(id).catch(reportErr),
  };
  const detail = new DetailViewProvider(context.extensionUri, store, insights, webviewHandlers);

  context.subscriptions.push(
    treeView,
    vscode.window.registerWebviewViewProvider(DetailViewProvider.viewId, detail),
  );

  // --- Unattended Fleet (governed auto-pilot) ---
  function unattendedConfig(): UnattendedConfig {
    const c = cfg();
    return {
      enabled: c.get<boolean>("unattended.enabled", false),
      nudgeStuckAfterSeconds: c.get<number>("unattended.nudgeStuckAfterSeconds", 90),
      maxNudges: c.get<number>("unattended.maxNudges", 3),
      maxCostUsd: c.get<number>("unattended.maxCostUsd", 0),
      pricing: c.get<UnattendedConfig["pricing"]>("unattended.pricing", {}),
    };
  }
  const unattendedCtl = new UnattendedController(store, unattendedConfig, {
    // Use ONLY the exact session-mapped terminal (no name fallback): an automated
    // nudge or stop must never hit a different agent's terminal — e.g. after a
    // host reload when the in-memory terminal map is gone, it simply no-ops.
    nudge: (id) =>
      terminals.sendText(
        id,
        "Continue with your plan. Keep working until the task is complete, or stop and tell me if you genuinely need my input.",
      ),
    pause: (id) => terminals.stop(id),
    notify: (msg) => void vscode.window.showWarningMessage(msg),
  });
  unattendedCtl.start();
  vscode.commands.executeCommand("setContext", "mas.unattended", unattendedConfig().enabled);
  context.subscriptions.push({ dispose: () => unattendedCtl.dispose() });

  async function setUnattended(next: boolean): Promise<void> {
    const c = cfg();
    const target = vscode.workspace.workspaceFolders?.length
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
    await c.update("unattended.enabled", next, target);
    vscode.commands.executeCommand("setContext", "mas.unattended", next);
    updatePulse();
    vscode.window.showInformationMessage(
      next
        ? "Unattended Fleet ON — new agents auto-accept edits (Bash still asks), stalled agents get nudged, and an estimated cost meter shows in Fleet Pulse."
        : "Unattended Fleet OFF.",
    );
  }

  // --- Fleet Pulse (ambient status-bar heartbeat) ---
  // Keeps a one-line fleet summary in the status bar even when the panel is
  // closed, and turns the warning color on the moment any agent needs you.
  const pulse = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  pulse.command = "mas.focusTopAttention";
  context.subscriptions.push(pulse);

  function topAttention(): AgentSession | undefined {
    const sessions = store.list();
    return (
      sessions.find((a) => a.status === "waiting" && !a.acknowledged) ||
      sessions.find((a) => a.status === "error" && !a.acknowledged) ||
      sessions.find((a) => a.status === "running" || a.status === "thinking")
    );
  }

  function updatePulse(): void {
    if (!cfg().get<boolean>("statusBar.enabled", true)) {
      pulse.hide();
      return;
    }
    const sessions = store.list();
    if (sessions.length === 0) {
      pulse.hide();
      return;
    }
    let running = 0;
    let needsYou = 0;
    let done = 0;
    for (const a of sessions) {
      if (a.status === "running" || a.status === "thinking") running++;
      else if ((a.status === "waiting" || a.status === "error") && !a.acknowledged) needsYou++;
      else if (a.status === "done") done++;
    }
    // Drives the conditional "Dismiss all needs-you" toolbar button.
    vscode.commands.executeCommand("setContext", "mas.hasNeedsYou", needsYou > 0);
    const idle = store.listVisible().filter((a) => a.status === "idle").length;
    const segs: string[] = [];
    if (running) segs.push(`${running} running`);
    if (needsYou) segs.push(`${needsYou} need${needsYou === 1 ? "s" : ""} you`);
    if (done) segs.push(`${done} done`);
    if (idle && segs.length < 2) segs.push(`${idle} idle`);
    if (cfg().get<boolean>("unattended.enabled", false)) {
      const cost = unattendedCtl.fleetCostUsd();
      if (cost > 0) segs.push(`~$${cost.toFixed(2)}`);
    }
    pulse.text = `$(pulse) ${segs.length ? segs.join(" · ") : "agents idle"}`;
    pulse.tooltip =
      `Agent View — ${sessions.length} session${sessions.length === 1 ? "" : "s"}` +
      (needsYou ? "\nClick to jump to the agent that needs you." : "\nClick to open the active agent.");
    pulse.backgroundColor = needsYou
      ? new vscode.ThemeColor("statusBarItem.warningBackground")
      : undefined;
    pulse.show();
  }
  context.subscriptions.push(store.onDidChange(updatePulse));
  updatePulse();

  // --- Hook server (live status + live "now doing X") ---
  const hookServer = new HookServer(store, (event) => {
    const id = event?.session_id || event?.sessionId;
    if (!id) return;
    const name = event?.hook_event_name || event?.hookEventName;
    if (name === "PreToolUse" && event?.tool_name) {
      store.applyLiveAction(id, humanizeTool(event.tool_name, event.tool_input));
    } else if (
      name === "PostToolUse" ||
      name === "PostToolUseFailure" ||
      name === "Stop" ||
      name === "SubagentStop" ||
      name === "SessionEnd"
    ) {
      // Tool finished (or turn ended) — clear the live phrase so the UI doesn't
      // keep showing "Running: …" after it's done; falls back to lastAction.
      store.applyLiveAction(id, undefined);
    }
  });
  const port = cfg().get<number>("hookPort", 47800);
  hookServer.start(port).catch((e) => {
    console.warn(`[claude-code-agent-view] hook server failed on port ${port}: ${e.message}`);
  });
  context.subscriptions.push({ dispose: () => hookServer.dispose() });

  // --- Notifications (needs-you / finished / error) ---
  const notifications = new NotificationController(
    store,
    () => {
      const c = cfg();
      return {
        enabled: c.get<boolean>("notifications.enabled", true),
        sound: c.get<boolean>("notifications.sound", true),
        onWaiting: c.get<boolean>("notifications.onWaiting", true),
        onDone: c.get<boolean>("notifications.onDone", true),
        onError: c.get<boolean>("notifications.onError", true),
      };
    },
    {
      focus: (id) => {
        const a = store.getById(id);
        terminals.focus(id, `Claude Code ${a?.gitBranch || ""}`.trim());
      },
      reveal: (id) => {
        vscode.commands.executeCommand("mas.detail.focus");
        detail.select(id);
      },
      openDiff: (id) =>
        openDiffFor(id).catch((e) => vscode.window.showErrorMessage(`Agent View: diff failed — ${e.message}`)),
    },
  );
  notifications.start();
  context.subscriptions.push({ dispose: () => notifications.dispose() });

  // --- Commands ---
  context.subscriptions.push(
    vscode.commands.registerCommand("mas.newAgent", runNewAgent),
    vscode.commands.registerCommand("mas.refresh", () => store.refresh()),
    vscode.commands.registerCommand("mas.openCanvas", () => void openCanvas()),
    vscode.commands.registerCommand("mas.toggleOlderAgents", () => store.setShowOlder(!store.showingOlder)),

    vscode.commands.registerCommand("mas.focusTopAttention", () => {
      const a = topAttention();
      if (a) {
        vscode.commands.executeCommand("mas.detail.focus");
        detail.select(a.sessionId);
      } else {
        vscode.commands.executeCommand("mas.agents.focus");
      }
    }),

    vscode.commands.registerCommand("mas.acknowledgeAgent", (arg?: AgentSession | string) => {
      const id = sessionIdOf(arg);
      if (id) store.acknowledge(id);
    }),

    vscode.commands.registerCommand("mas.unacknowledgeAgent", (arg?: AgentSession | string) => {
      const id = sessionIdOf(arg);
      if (id) store.unacknowledge(id);
    }),

    vscode.commands.registerCommand("mas.acknowledgeAllNeedsYou", () => {
      const n = store.acknowledgeAllNeedsYou();
      vscode.window.showInformationMessage(
        n > 0
          ? `Agent View: dismissed ${n} "needs you" agent${n === 1 ? "" : "s"}. They resurface on new activity.`
          : `Agent View: nothing waiting on you right now.`,
      );
    }),

    vscode.commands.registerCommand("mas.openAgent", (arg?: AgentSession | string) => {
      const id = sessionIdOf(arg);
      if (!id) return;
      vscode.commands.executeCommand("mas.detail.focus");
      detail.select(id);
    }),

    vscode.commands.registerCommand("mas.focusTerminal", (arg?: AgentSession | string) => {
      const id = sessionIdOf(arg);
      if (!id) return;
      const agent = store.getById(id);
      const ok = terminals.focus(id, `Claude Code ${agent?.gitBranch || ""}`.trim());
      if (!ok)
        vscode.window.showWarningMessage(
          "Agent View: no live terminal for this agent (it may be external or closed).",
        );
    }),

    vscode.commands.registerCommand("mas.stopAgent", async (arg?: AgentSession | string) => {
      const id = sessionIdOf(arg);
      if (!id) return;
      const managed = registry.get(id);
      const confirm = await vscode.window.showWarningMessage(
        `Stop agent ${managed?.label || id.slice(0, 8)}?`,
        { modal: true },
        "Stop",
      );
      if (confirm !== "Stop") return;
      terminals.stop(id, `Claude Code ${managed?.branch || ""}`.trim());
      await registry.remove(id);
      store.refresh();
    }),

    vscode.commands.registerCommand("mas.openDiff", async (arg?: AgentSession | string) => {
      const id = sessionIdOf(arg);
      if (!id) return;
      try {
        await openDiffFor(id);
      } catch (e: any) {
        vscode.window.showErrorMessage(`Agent View: diff failed — ${e.message}`);
      }
    }),

    vscode.commands.registerCommand("mas.raceAgents", async () => {
      const cwd = defaultCwd();
      if (!cwd) {
        vscode.window.showErrorMessage("Agent View: open a folder/workspace first.");
        return;
      }
      if (!(await isGitRepo(cwd))) {
        vscode.window.showWarningMessage(
          "Agent Race needs a git repository — each contender runs in its own worktree.",
        );
        return;
      }
      const task = await vscode.window.showInputBox({
        title: "Agent Race",
        prompt: "Task to give every contender (they all get the same prompt)",
        placeHolder: "e.g. Fix the failing auth test",
      });
      if (!task) return;
      const defaultCount = cfg().get<number>("race.defaultCount", 3);
      const countPick = await vscode.window.showQuickPick(["2", "3", "4", "5"], {
        title: "How many agents should race?",
        placeHolder: `default ${defaultCount}`,
      });
      if (countPick === undefined) return;
      const count = parseInt(countPick, 10) || defaultCount;
      try {
        const { groupId } = await spawnRace({ cwd, task, count }, registry, spawnConfig());
        vscode.commands.executeCommand("mas.detail.focus");
        detail.openRace(groupId);
        nudgeHooksForLive();
        setTimeout(() => store.refresh(), 800);
        void vscode.window
          .showInformationMessage(
            `Race started: ${count} agents on "${truncate(task, 60)}".`,
            "Open Pinboard",
          )
          .then((pick) => {
            if (pick === "Open Pinboard") vscode.commands.executeCommand("mas.openCanvas");
          });
      } catch (e: any) {
        vscode.window.showErrorMessage(`Agent View: failed to start race — ${e.message}`);
      }
    }),

    vscode.commands.registerCommand("mas.fanOutAgents", () => {
      vscode.commands.executeCommand("mas.detail.focus");
      detail.openFanout();
    }),

    vscode.commands.registerCommand("mas.review", () => {
      vscode.commands.executeCommand("mas.detail.focus");
      detail.openReview();
    }),

    vscode.commands.registerCommand("mas.toggleUnattended", () =>
      setUnattended(!cfg().get<boolean>("unattended.enabled", false)),
    ),
    vscode.commands.registerCommand("mas.unattendedOn", () => setUnattended(true)),
    vscode.commands.registerCommand("mas.unattendedOff", () => setUnattended(false)),

    vscode.commands.registerCommand("mas.fanOutSelection", () => {
      const ed = vscode.window.activeTextEditor;
      const sel = ed && !ed.selection.isEmpty ? ed.document.getText(ed.selection) : "";
      if (!sel.trim()) {
        vscode.window.showWarningMessage(
          "Fan-out: select some lines first, or use the Fan-out tab in the Agent View panel.",
        );
        return;
      }
      void runFanOut(sel);
    }),

    vscode.commands.registerCommand("mas.cleanupWorktrees", async () => {
      const groups = new Map<string, ManagedAgent[]>();
      for (const m of registry.all()) {
        if (!m.groupId) continue;
        const arr = groups.get(m.groupId) ?? [];
        arr.push(m);
        groups.set(m.groupId, arr);
      }
      if (groups.size === 0) {
        vscode.window.showInformationMessage("Agent View: no race/fan-out worktree groups to clean up.");
        return;
      }
      const items = [...groups.entries()].map(([gid, ms]) => ({
        label: `${ms[0].groupRole === "race" ? "race" : "batch"} ${gid} · ${ms.length} agent${ms.length === 1 ? "" : "s"}`,
        description: ms[0].task ? truncate(ms[0].task, 50) : "",
        gid,
      }));
      const pick = await vscode.window.showQuickPick(items, {
        title: "Clean up which group's worktrees?",
      });
      if (!pick) return;
      const confirm = await vscode.window.showWarningMessage(
        `Remove ${groups.get(pick.gid)!.length} worktrees for ${pick.gid}? Branches are kept.`,
        { modal: true },
        "Clean up",
      );
      if (confirm !== "Clean up") return;
      const { removed, errors } = await cleanupGroup(pick.gid, registry);
      raceWinner.delete(pick.gid);
      store.refresh();
      vscode.window.showInformationMessage(
        `Agent View: removed ${removed} worktree${removed === 1 ? "" : "s"}.` +
          (errors.length ? ` Errors: ${errors.join("; ")}` : ""),
      );
    }),

    vscode.commands.registerCommand("mas.configureHooks", async () => {
      try {
        const p = installHooks(cfg().get<number>("hookPort", 47800));
        vscode.window.showInformationMessage(
          `Agent View: hooks installed in ${p}. New Claude Code sessions will stream live status.`,
        );
      } catch (e: any) {
        vscode.window.showErrorMessage(`Agent View: could not install hooks — ${e.message}`);
      }
    }),

    vscode.commands.registerCommand("mas.removeHooks", async () => {
      try {
        const p = removeHooks();
        vscode.window.showInformationMessage(`Agent View: removed agent-view hooks from ${p}.`);
      } catch (e: any) {
        vscode.window.showErrorMessage(`Agent View: could not remove hooks — ${e.message}`);
      }
    }),

    vscode.commands.registerCommand("mas.mergeAdvisor", async () => {
      const managed = store.list().filter((a) => a.managed);
      if (managed.length < 2) {
        vscode.window.showWarningMessage(
          "Merge Advisor needs at least 2 Agent View-spawned (worktree) agents to compare.",
        );
        return;
      }
      if (!(await requireLlmConsent(context))) return;
      const c = cfg();
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Merge Advisor: ranking agents…" },
        async () => {
          try {
            const { report } = await runMergeAdvisor(
              managed,
              registry,
              c.get<string>("claudePath", "claude"),
              c.get<string>("insights.mergeModel", "claude-sonnet-4-6"),
            );
            const doc = await vscode.workspace.openTextDocument({ content: report, language: "markdown" });
            await vscode.window.showTextDocument(doc, { preview: true });
          } catch (e: any) {
            vscode.window.showErrorMessage(`Merge Advisor: ${e.message}`);
          }
        },
      );
    }),
  );

  context.subscriptions.push({ dispose: () => store.dispose() });
  context.subscriptions.push({ dispose: () => boardStore?.dispose() });
  context.subscriptions.push({ dispose: () => terminals.dispose() });
  context.subscriptions.push({ dispose: () => insights.dispose() });
  context.subscriptions.push({
    dispose: () => {
      for (const b of activeBatches) b.dispose();
      activeBatches.clear();
    },
  });

  store.start();
  insights.start();

  // Gentle nudge to enable live status the first time.
  if (!hooksInstalled()) {
    vscode.window
      .showInformationMessage(
        "Agent View is monitoring your Claude Code sessions. Enable hooks for real-time status?",
        "Configure Hooks",
        "Not now",
      )
      .then((pick) => {
        if (pick === "Configure Hooks") vscode.commands.executeCommand("mas.configureHooks");
      });
  }
}

export function deactivate(): void {
  // subscriptions disposed by VS Code
}
