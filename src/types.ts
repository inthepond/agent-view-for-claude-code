// Shared domain types for the MAS extension host.

export type AgentStatus =
  | "idle"
  | "running"
  | "thinking" // reasoning, or delegating to (active) subagents — not idle
  | "waiting" // waiting for user input / permission
  | "done"
  | "error"
  | "unknown";

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
}

export function emptyTokens(): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
}

/** Progress of an agent's own TodoWrite plan. */
export interface PlanProgress {
  done: number;
  total: number;
  /** activeForm (or content) of the item currently in progress. */
  current?: string;
}

export interface AgentSession {
  /** Claude Code session UUID (file stem of the transcript). */
  sessionId: string;
  /** Encoded project directory name under ~/.claude/projects. */
  projectDir: string;
  /** Real working directory, read from the transcript's `cwd` field. */
  cwd: string;
  /** Absolute path to the <session-id>.jsonl transcript. */
  jsonlPath: string;
  /** Human label — first user prompt or ai-title. */
  label: string;
  status: AgentStatus;
  model?: string;
  gitBranch?: string;
  tokens: TokenUsage;
  /** Epoch ms of the most recent transcript line. */
  lastActivity: number;
  messageCount: number;
  /** Short summary of the agent's most recent action ("Read foo.ts", …). */
  lastAction?: string;
  /**
   * Live "now doing X" phrase from the most recent hook tool event — fresher
   * than `lastAction` (which only updates per assistant turn). Set by the store
   * from PreToolUse events, cleared on Stop. Falls back to `lastAction`.
   */
  liveAction?: string;
  /** Files the agent edited/wrote — used for cross-agent conflict detection. */
  filesTouched?: string[];
  /** The agent's own TodoWrite plan progress, if it has one. */
  plan?: PlanProgress;
  /** Reason the agent's most recent tool failed, while still unrecovered. */
  lastError?: string;
  /** True when MAS spawned this agent (and owns its worktree). */
  managed: boolean;
  worktreePath?: string;
  /** Race/fan-out group id — managed agents spawned together share one. */
  groupId?: string;
  /** Role within the group: competitive "race" or independent "fanout" batch. */
  groupRole?: "race" | "fanout";
  kind: "session" | "subagent";
  /** For subagents: the parent session id. */
  parentId?: string;
  agentType?: string;
  /** Discovered child subagents (populated for top-level sessions). */
  subagents?: AgentSession[];
  /** Source that last set the status: "hook" is authoritative over "jsonl". */
  statusSource?: "hook" | "jsonl";
  /** User manually dismissed this from "needs you" (until it next acts). */
  acknowledged?: boolean;
}
