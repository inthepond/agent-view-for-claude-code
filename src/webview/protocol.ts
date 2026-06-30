import { AgentStatus, PlanProgress } from "../types";

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
  /** Live "now doing X" phrase from hooks (fresher than lastAction). */
  liveAction?: string;
  /** The agent's own TodoWrite plan progress, if it has one. */
  plan?: PlanProgress;
  /** Reason the agent's most recent tool failed, while still unrecovered. */
  lastError?: string;
  /** User manually dismissed this from "needs you". */
  acknowledged?: boolean;
  managed: boolean;
  kind: "session" | "subagent";
  parentId?: string;
  agentType?: string;
  groupId?: string;
  groupRole?: "race" | "fanout";
  /** Count of this session's subagents currently running/waiting. */
  activeSubagents?: number;
}

export interface TranscriptMessage {
  role: "user" | "assistant" | "tool" | "thinking";
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

/** Which top-level surface the detail panel is showing. */
export type ViewMode = "detail" | "race" | "fanout" | "review";

/** One managed agent's work, ready to review and land. */
export interface ReviewItem {
  sessionId: string;
  label: string;
  branch?: string;
  status: AgentStatus;
  files: number;
  additions: number;
  deletions: number;
  /** The worktree has changes the agent hasn't committed (land will snapshot them). */
  hasUncommitted: boolean;
  plan?: PlanProgress;
  lastError?: string;
  groupId?: string;
  groupRole?: "race" | "fanout";
  tokensTotal: number;
  lastActivity: number;
}

export interface ReviewQueue {
  items: ReviewItem[];
  /** mas.review.allowLand — gates the squash-merge action (off by default). */
  allowLand: boolean;
  /** The GitHub `gh` CLI is available, so "Open PR" can create one directly. */
  ghAvailable: boolean;
}

/** One contender in an Agent Race. */
export interface RaceCandidate {
  sessionId: string;
  index: number;
  label: string;
  status: AgentStatus;
  tokensTotal: number;
  branch?: string;
  liveAction?: string;
  lastAction?: string;
  /** Score from an optional AI ranking pass (Merge Advisor). */
  score?: number;
  recommended?: boolean;
}

export interface RaceGroup {
  groupId: string;
  task: string;
  candidates: RaceCandidate[];
  /** Session the user marked as the winner (purely advisory — nothing auto-merges). */
  winnerId?: string;
  ranked?: boolean;
}

export type ExtToWeb =
  | { type: "fleet"; agents: AgentSummary[] }
  | { type: "transcript"; sessionId: string; messages: TranscriptMessage[] }
  | { type: "selected"; sessionId: string | null }
  | { type: "insights"; conflicts: Conflict[]; router: RouterItem[] }
  | { type: "view"; view: ViewMode }
  | { type: "race"; group: RaceGroup | null }
  | { type: "review"; queue: ReviewQueue };

export type WebToExt =
  | { type: "ready" }
  | { type: "select"; sessionId: string }
  | { type: "newAgent" }
  | { type: "refresh" }
  | { type: "setView"; view: ViewMode }
  | { type: "pickWinner"; sessionId: string }
  | { type: "openCandidateDiff"; sessionId: string }
  | { type: "openAllDiffs"; groupId: string }
  | { type: "rankRace"; groupId: string }
  | { type: "cleanupRace"; groupId: string }
  | { type: "fanOut"; text: string }
  | { type: "acknowledge"; sessionId: string }
  | { type: "acknowledgeAll" }
  | { type: "refreshReview" }
  | { type: "openReviewDiff"; sessionId: string }
  | { type: "requestChanges"; sessionId: string; comment: string }
  | { type: "landAgent"; sessionId: string }
  | { type: "openPR"; sessionId: string }
  | { type: "copyMerge"; sessionId: string }
  | { type: "cleanupAgent"; sessionId: string };
