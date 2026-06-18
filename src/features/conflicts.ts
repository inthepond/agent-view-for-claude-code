import { AgentSession } from "../types";
import { Conflict } from "../webview/protocol";

/**
 * Conflict Radar (local-only, no LLM): find files edited by more than one agent.
 * This is the cheap "they both touched it" tier — a precise git-merge check can
 * be layered on later for managed worktree agents.
 */
export function computeConflicts(sessions: AgentSession[]): Conflict[] {
  const byFile = new Map<string, { sessionId: string; label: string }[]>();

  for (const s of sessions) {
    for (const file of s.filesTouched || []) {
      const arr = byFile.get(file) ?? [];
      if (!arr.some((a) => a.sessionId === s.sessionId)) {
        arr.push({ sessionId: s.sessionId, label: s.label });
        byFile.set(file, arr);
      }
    }
  }

  const conflicts: Conflict[] = [];
  for (const [file, agents] of byFile) {
    if (agents.length >= 2) conflicts.push({ file, agents });
  }
  conflicts.sort((a, b) => b.agents.length - a.agents.length);
  return conflicts.slice(0, 30);
}
