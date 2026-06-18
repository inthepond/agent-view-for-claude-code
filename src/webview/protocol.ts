import { AgentStatus } from "../types";

/** Flattened agent shape sent to the webview. */
export interface AgentSummary {
  sessionId: string;
  label: string;
  status: AgentStatus;
  statusSource?: "hook" | "jsonl";
  model?: string;
  gitBranch?: string;
  tokensTotal: number;
  lastActivity: number;
  messageCount: number;
  lastAction?: string;
  managed: boolean;
  kind: "session" | "subagent";
  parentId?: string;
  agentType?: string;
}

export interface TranscriptMessage {
  role: "user" | "assistant" | "tool";
  text: string;
  ts: number;
  tool?: string;
}

export interface Conflict {
  file: string;
  agents: { sessionId: string; label: string }[];
}

export interface RouterItem {
  sessionId: string;
  label: string;
  urgency: "needs-you" | "watch" | "ok";
  reason: string;
  action?: string;
  source: "rules" | "ai";
}

export type ExtToWeb =
  | { type: "fleet"; agents: AgentSummary[] }
  | { type: "transcript"; sessionId: string; messages: TranscriptMessage[] }
  | { type: "selected"; sessionId: string | null }
  | { type: "insights"; conflicts: Conflict[]; router: RouterItem[] };

export type WebToExt =
  | { type: "ready" }
  | { type: "select"; sessionId: string }
  | { type: "newAgent" }
  | { type: "refresh" };
