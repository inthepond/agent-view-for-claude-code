import { AgentSession } from "../types";
import { RouterItem } from "../webview/protocol";
import { runClaude, extractJson } from "../llm/runner";
import { stripMarkdown } from "../util/markdown";

const STALE_MS = 3 * 60 * 1000;
const URGENCY_RANK: Record<RouterItem["urgency"], number> = { "needs-you": 0, watch: 1, ok: 2 };

function sortItems(items: RouterItem[]): RouterItem[] {
  return [...items].sort((a, b) => URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency]);
}

/** Free, deterministic triage from status + recency (used standalone or as LLM fallback). */
export function rulesRouter(sessions: AgentSession[]): RouterItem[] {
  const items = sessions.map((s): RouterItem => {
    const age = Date.now() - s.lastActivity;
    let urgency: RouterItem["urgency"] = "ok";
    let reason = "Idle.";
    if (s.acknowledged) {
      reason = "Dismissed — resurfaces on new activity.";
    } else if (s.status === "waiting") {
      urgency = "needs-you";
      reason = "Waiting for your input.";
    } else if (s.status === "error") {
      urgency = "needs-you";
      reason = s.lastError || "Hit an error.";
    } else if (s.status === "done") {
      urgency = "watch";
      reason = "Finished — ready to review.";
    } else if (s.status === "running" && age > STALE_MS) {
      urgency = "watch";
      reason = "Running but quiet a while — may be stuck.";
    } else if (s.status === "running") {
      urgency = "ok";
      reason = "Working.";
    }
    return { sessionId: s.sessionId, label: s.label, urgency, reason, source: "rules" };
  });
  return sortItems(items);
}

interface Digest {
  sessionId: string;
  label: string;
  status: string;
  model?: string;
  lastAction?: string;
  lastError?: string;
  plan?: string;
  files: string[];
  subagents: number;
  idleSeconds: number;
}

function toDigest(s: AgentSession): Digest {
  return {
    sessionId: s.sessionId,
    label: s.label,
    status: s.status,
    model: s.model,
    lastAction: s.lastAction,
    lastError: s.lastError,
    plan: s.plan && s.plan.total > 0 ? `${s.plan.done}/${s.plan.total} done` : undefined,
    files: (s.filesTouched || []).slice(0, 6),
    subagents: s.subagents?.length || 0,
    idleSeconds: Math.round((Date.now() - s.lastActivity) / 1000),
  };
}

/** AI triage via headless Claude (Haiku by default). Throws on bad output so callers can fall back. */
export async function aiRouter(
  sessions: AgentSession[],
  claudePath: string,
  model: string,
): Promise<RouterItem[]> {
  if (sessions.length === 0) return [];
  const digests = sessions.map(toDigest);
  const prompt =
    `You are triaging Claude Code coding agents for a developer. Decide how urgently each needs the developer's attention.\n` +
    `Return ONLY a JSON array (no prose, no markdown fences), one object per agent:\n` +
    `[{"sessionId":"...","urgency":"needs-you"|"watch"|"ok","reason":"<= 12 words","action":"<= 6 words imperative"}]\n` +
    `- needs-you: blocked on the developer (waiting for input/permission), errored, or stuck in a loop.\n` +
    `- watch: finished and ready to review, or running but possibly stuck.\n` +
    `- ok: healthy/working/idle, nothing to do.\n\n` +
    `Agents:\n${JSON.stringify(digests, null, 1)}`;

  const raw = await runClaude(prompt, { claudePath, model, timeoutMs: 90_000 });
  const parsed = extractJson<
    { sessionId: string; urgency: RouterItem["urgency"]; reason: string; action?: string }[]
  >(raw);
  if (!parsed || !Array.isArray(parsed)) throw new Error("router: could not parse LLM output");

  const byId = new Map(sessions.map((s) => [s.sessionId, s]));
  const valid: RouterItem["urgency"][] = ["needs-you", "watch", "ok"];
  const items = parsed
    .filter((p) => byId.has(p.sessionId))
    .map((p): RouterItem => ({
      sessionId: p.sessionId,
      label: byId.get(p.sessionId)!.label,
      urgency: valid.includes(p.urgency) ? p.urgency : "ok",
      reason: stripMarkdown(String(p.reason || "")).slice(0, 100),
      action: p.action ? stripMarkdown(String(p.action)).slice(0, 40) : undefined,
      source: "ai",
    }));
  return sortItems(items);
}
