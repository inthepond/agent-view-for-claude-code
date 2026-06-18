// Shared domain types for the MAS extension host.

export type AgentStatus =
  | "idle"
  | "running"
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
  /** Files the agent edited/wrote — used for cross-agent conflict detection. */
  filesTouched?: string[];
  /** True when MAS spawned this agent (and owns its worktree). */
  managed: boolean;
  worktreePath?: string;
  kind: "session" | "subagent";
  /** For subagents: the parent session id. */
  parentId?: string;
  agentType?: string;
  /** Discovered child subagents (populated for top-level sessions). */
  subagents?: AgentSession[];
  /** Source that last set the status: "hook" is authoritative over "jsonl". */
  statusSource?: "hook" | "jsonl";
}
