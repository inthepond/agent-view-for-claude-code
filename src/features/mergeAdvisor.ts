import { AgentSession } from "../types";
import { Registry } from "../orchestrator/registry";
import { worktreeDiff, currentRef } from "../orchestrator/worktree";
import { runClaude, extractJson } from "../llm/runner";

export interface MergeRanking {
  sessionId: string;
  label: string;
  branch?: string;
  score: number;
  rationale: string;
  concerns: string[];
}

const MAX_DIFF_CHARS = 12_000;

/**
 * Merge Advisor: gather each managed agent's worktree diff, ask Claude (Sonnet
 * by default) to rank them by merge-worthiness, and return a markdown report.
 * Consumes subscription usage — caller must gate behind consent.
 */
export async function runMergeAdvisor(
  managed: AgentSession[],
  registry: Registry,
  claudePath: string,
  model: string,
): Promise<{ rankings: MergeRanking[]; report: string }> {
  const entries: { session: AgentSession; branch: string; diff: string }[] = [];
  for (const s of managed) {
    const m = registry.get(s.sessionId);
    if (!m?.worktreePath) continue;
    let diff = "";
    try {
      const base = await currentRef(m.repoRoot);
      diff = await worktreeDiff(m.worktreePath, base);
    } catch {
      diff = "";
    }
    entries.push({ session: s, branch: m.branch, diff: diff.slice(0, MAX_DIFF_CHARS) });
  }

  if (entries.length < 2) {
    throw new Error("Need at least 2 managed agents with worktrees to compare.");
  }

  const prompt =
    `You are a senior engineer comparing ${entries.length} candidate implementations of the same task, ` +
    `each produced by a different Claude Code agent in its own git worktree. Rank them by which is best to merge.\n` +
    `Return ONLY a JSON array (no prose, no markdown fences):\n` +
    `[{"sessionId":"...","score":0-100,"rationale":"<= 25 words","concerns":["..."]}]\n` +
    `Judge correctness, completeness, and risk. Higher score = better.\n\n` +
    entries
      .map(
        (e, i) =>
          `=== Candidate ${i + 1} | sessionId=${e.session.sessionId} | task: ${e.session.label} ===\n` +
          `${e.diff || "(no diff yet)"}`,
      )
      .join("\n\n");

  const raw = await runClaude(prompt, { claudePath, model, timeoutMs: 180_000 });
  const parsed = extractJson<MergeRanking[]>(raw);
  const byId = new Map(entries.map((e) => [e.session.sessionId, e]));

  let rankings: MergeRanking[] = [];
  if (parsed && Array.isArray(parsed)) {
    rankings = parsed
      .filter((p) => byId.has(p.sessionId))
      .map((p): MergeRanking => {
        const e = byId.get(p.sessionId)!;
        return {
          sessionId: p.sessionId,
          label: e.session.label,
          branch: e.branch,
          score: Number(p.score) || 0,
          rationale: String(p.rationale || ""),
          concerns: Array.isArray(p.concerns) ? p.concerns.map(String) : [],
        };
      })
      .sort((a, b) => b.score - a.score);
  }

  const lines: string[] = ["# Merge Advisor", "", `Compared ${entries.length} agents.`, ""];
  if (rankings.length === 0) {
    lines.push("> Could not parse a ranking from the model. Raw output:", "", "```", raw.slice(0, 4000), "```");
  }
  rankings.forEach((r, i) => {
    lines.push(`## ${i + 1}. ${r.label} — score ${r.score}${i === 0 ? "  ⭐ recommended" : ""}`);
    lines.push("", r.rationale, "");
    if (r.branch) lines.push(`Branch: \`${r.branch}\``, "");
    if (r.concerns.length) {
      lines.push("**Concerns:**");
      r.concerns.forEach((c) => lines.push(`- ${c}`));
      lines.push("");
    }
  });

  return { rankings, report: lines.join("\n") };
}
