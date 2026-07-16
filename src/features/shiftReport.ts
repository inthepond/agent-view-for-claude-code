import { AgentSession } from "../types";
import { AgentStore } from "../store";
import { estimateCostUsd, UnattendedConfig } from "./unattended";
import { runClaude, LlmOptions } from "../llm/runner";
import { readEventStrip } from "../transcript";

/** One managed agent's shift summary line. */
export interface ShiftRow {
  sessionId: string;
  label: string;
  status: string;
  branch?: string;
  plan?: { done: number; total: number };
  costUsd: number;
  tokensTotal: number;
  diff?: { files: number; additions: number; deletions: number };
  evidence?: { ok: boolean; passed: number; total: number };
  needsYou: boolean;
  lastError?: string;
  lastActivity: number;
  /** The shift's shape as a glyph line (see stripGlyphs). */
  shape?: string;
}

/** Glyphs a markdown code span can carry: █ you · ¶ model prose · ▒ thinking
 *  · ▪ tool call · · result/system. Wide sessions downsample to fit. */
const SHAPE_WIDTH = 100;
export function stripGlyphs(seq: string, width = SHAPE_WIDTH): string {
  const glyph = (c: string): string => {
    if (c === "H") return "█";
    if (c === "T") return "¶";
    if (c === "K") return "▒";
    if (c === "r" || c === "m") return "·";
    return "▪";
  };
  if (seq.length <= width) return [...seq].map(glyph).join("");
  const step = Math.ceil(seq.length / width);
  const out: string[] = [];
  for (let i = 0; i < seq.length; i++) {
    if (seq[i] === "H" || i % step === 0) out.push(glyph(seq[i]));
  }
  return out.join("");
}

/** Host-provided lookups (git + evidence live in the extension host). */
export interface ShiftDeps {
  /** Diff stat for a managed agent's worktree (undefined when unavailable). */
  diffStat(
    sessionId: string,
  ): Promise<{ files: number; additions: number; deletions: number } | undefined>;
  evidence(sessionId: string): { ok: boolean; passed: number; total: number } | undefined;
}

/** Snapshot every managed agent into a report row (concurrently — diffStat
 *  shells out to git per agent, and the report should open fast). */
export async function buildShiftRows(
  store: AgentStore,
  pricing: UnattendedConfig["pricing"],
  deps: ShiftDeps,
): Promise<ShiftRow[]> {
  const managed = store
    .list()
    .filter((a): a is AgentSession => a.kind === "session" && a.managed);
  const rows = await Promise.all(
    managed.map(
      async (a): Promise<ShiftRow> => ({
        sessionId: a.sessionId,
        label: a.label || a.sessionId.slice(0, 8),
        status: a.status,
        branch: a.gitBranch,
        plan: a.plan && a.plan.total > 0 ? { done: a.plan.done, total: a.plan.total } : undefined,
        costUsd: estimateCostUsd(a.tokens, a.model, pricing),
        tokensTotal: a.tokens.input + a.tokens.output + a.tokens.cacheRead + a.tokens.cacheCreate,
        diff: await deps.diffStat(a.sessionId).catch(() => undefined),
        evidence: deps.evidence(a.sessionId),
        needsYou: (a.status === "waiting" || a.status === "error") && !a.acknowledged,
        lastError: a.lastError,
        lastActivity: a.lastActivity,
        shape: (() => {
          const s = readEventStrip(a.jsonlPath);
          return s && s.seq.length > 1 ? stripGlyphs(s.seq) : undefined;
        })(),
      }),
    ),
  );
  // Most attention-worthy first: needs-you, then recency.
  rows.sort((x, y) => Number(y.needsYou) - Number(x.needsYou) || y.lastActivity - x.lastActivity);
  return rows;
}

/** Same abbreviation scheme as util/format.formatTokens so the report never
 *  disagrees with the tree/webview about the same agent's token count. */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function evidenceCell(e: ShiftRow["evidence"]): string {
  if (!e) return "—";
  return e.ok ? `${e.passed}/${e.total} pass` : `${e.passed}/${e.total} FAIL`;
}

/** Deterministic, LLM-free report body — always available. */
export function formatShiftReport(rows: ShiftRow[], narrative?: string): string {
  const lines: string[] = [];
  lines.push(`# Fleet Shift Report`);
  lines.push("");
  if (narrative) {
    lines.push(narrative.trim());
    lines.push("");
  }
  const needs = rows.filter((r) => r.needsYou);
  if (needs.length > 0) {
    lines.push(`## Waiting on you (${needs.length})`);
    lines.push("");
    for (const r of needs) {
      const why = r.status === "error" ? `error — ${r.lastError || "see transcript"}` : "waiting for input";
      lines.push(`- **${r.label}**${r.branch ? ` (\`${r.branch}\`)` : ""} — ${why}`);
    }
    lines.push("");
  }
  lines.push(`## Fleet (${rows.length} agent${rows.length === 1 ? "" : "s"})`);
  lines.push("");
  lines.push(`| Agent | Status | Plan | Diff | Checks | Tokens | Est. cost |`);
  lines.push(`|---|---|---|---|---|---|---|`);
  for (const r of rows) {
    const plan = r.plan ? `${r.plan.done}/${r.plan.total}` : "—";
    const diff = r.diff ? `${r.diff.files}f +${r.diff.additions} −${r.diff.deletions}` : "—";
    lines.push(
      `| ${r.label.replace(/\|/g, "\\|")} | ${r.status} | ${plan} | ${diff} | ${evidenceCell(r.evidence)} | ${fmtTokens(r.tokensTotal)} | $${r.costUsd.toFixed(2)} |`,
    );
  }
  lines.push("");
  const shaped = rows.filter((r) => r.shape);
  if (shaped.length > 0) {
    lines.push(`## Session shapes`);
    lines.push("");
    lines.push(`One line per agent, oldest event to newest — █ you · ¶ model prose · ▒ thinking · ▪ tool call · · result.`);
    lines.push("");
    for (const r of shaped) {
      lines.push(`- **${r.label.replace(/\|/g, "\\|")}**`);
      lines.push(`  \`${r.shape}\``);
    }
    lines.push("");
  }
  const totalCost = rows.reduce((s, r) => s + r.costUsd, 0);
  const totalFiles = rows.reduce((s, r) => s + (r.diff?.files || 0), 0);
  const green = rows.filter((r) => r.evidence?.ok).length;
  const checked = rows.filter((r) => r.evidence).length;
  lines.push(
    `Totals: ~$${totalCost.toFixed(2)} estimated, ${totalFiles} files changed across the fleet` +
      (checked > 0 ? `, ${green}/${checked} agents green on evidence checks.` : `.`),
  );
  lines.push("");
  lines.push(
    `_Estimates only. Review diffs before landing — evidence checks are proof of passing commands, not of correctness._`,
  );
  return lines.join("\n");
}

/** Optional LLM narrative — a short human briefing on top of the table.
 *  Callers must gate this behind LLM consent; failures fall back to no
 *  narrative rather than blocking the report. */
export async function narrateShift(rows: ShiftRow[], opts: LlmOptions): Promise<string | undefined> {
  if (rows.length === 0) return undefined;
  const compact = rows.map((r) => ({
    label: r.label,
    status: r.status,
    needsYou: r.needsYou,
    plan: r.plan,
    diff: r.diff,
    evidence: r.evidence,
    error: r.lastError,
  }));
  const prompt =
    `You are writing the opening paragraph of a shift report for a developer who just came back to their multi-agent coding fleet. ` +
    `Given this JSON snapshot of managed agents, write 2-4 plain sentences: what got done, what is blocked on the human and why it matters, and anything risky (failing checks, errors). ` +
    `No headings, no lists, no markdown emphasis, no emoji. Be concrete and use the agent labels.\n\n` +
    JSON.stringify(compact);
  try {
    const text = (await runClaude(prompt, opts)).trim();
    return text.length > 0 && text.length < 2000 ? text : undefined;
  } catch {
    return undefined;
  }
}
