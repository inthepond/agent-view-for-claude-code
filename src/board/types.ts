// Pinboard domain + webview protocol types (extension-host side).
// The webview mirror lives in webview-ui/src/board/protocol.ts (kept in sync
// manually — the two packages have separate tsconfig roots).
import type { AgentSummary } from "../webview/protocol";
import type { AgentStatus } from "../types";

// ---- Teams cockpit ----

export type TeamTaskStatus = "pending" | "in_progress" | "completed";

/** A teammate in an Agent Teams-style run (a named subagent). */
export interface TeamMember {
  sessionId: string;
  name: string;
  agentType?: string;
  /** "plan" => spawned read-only awaiting the lead's plan approval. */
  spawnMode?: string;
  status: AgentStatus;
  tokensTotal: number;
  lastAction?: string;
}

/** One task from the lead's shared task list (the TodoWrite list today). */
export interface TeamTask {
  id: string;
  content: string;
  status: TeamTaskStatus;
  /** Teammate name parsed from an "owner: X" hint, if present. */
  owner?: string;
  /** Task ids this one depends on (parsed from "DEPENDS ON N"). */
  dependsOn: string[];
}

export interface TeamWorkflowRun {
  id: string;
  agentCount: number;
}

/** One active team: its lead session, roster, and shared task graph. */
export interface Team {
  leadSessionId: string;
  leadLabel: string;
  members: TeamMember[];
  tasks: TeamTask[];
  workflowRuns: TeamWorkflowRun[];
}

/** A live snapshot of every active team (the cockpit switches between them). */
export interface TeamSnapshot {
  present: boolean;
  /** Where the data came from — the native store, or the TodoWrite fallback. */
  source: "native" | "todowrite" | "none";
  /** All active teams, most-recently-active first. */
  teams: Team[];
  /** ~/.claude/teams or ~/.claude/tasks exists (native Agent Teams store). */
  nativeStoreDetected: boolean;
}

export type BoardCardKind = "diff" | "note" | "doc" | "output" | "image" | "result";

/** A durable artifact frozen onto the board (persisted + git-committable). */
export interface BoardCard {
  id: string;
  kind: BoardCardKind;
  title: string;
  /** Markdown/plain body for note/doc/output/result cards. */
  body?: string;
  /** Unified-diff text for diff cards. */
  diffText?: string;
  branch?: string;
  /** The commit the diff was frozen at — lets us flag staleness later. */
  pinnedAtCommit?: string;
  baseRef?: string;
  sourceSessionId?: string;
  filePath?: string;
  x: number;
  y: number;
  w?: number;
  createdBy: "human" | "agent";
  createdAt: number;
}

/** A human/agent annotation linking two cards (or free points) with a label. */
export interface BoardArrow {
  id: string;
  fromCard?: string;
  toCard?: string;
  fromPoint?: { x: number; y: number };
  toPoint?: { x: number; y: number };
  label?: string;
  createdAt: number;
}

export interface BoardCamera {
  x: number;
  y: number;
  zoom: number;
}

/** The persisted board document (one tldraw-free page). */
export interface BoardDoc {
  version: number;
  cards: BoardCard[];
  arrows: BoardArrow[];
  camera?: BoardCamera;
  updatedAt: number;
}

export function emptyBoard(): BoardDoc {
  return { version: 1, cards: [], arrows: [], updatedAt: 0 };
}

/** One selected card, distilled into an agent-legible brief. */
export interface BoardSelectionEntry {
  cardId: string;
  kind: BoardCardKind;
  title: string;
  body?: string;
  diffExcerpt?: string;
  filePath?: string;
  branch?: string;
  sourceSessionId?: string;
}

/** Written to selection.json — what the human is currently focused on. */
export interface BoardSelectionFile {
  version: number;
  updatedAt: number;
  canvasOpen: boolean;
  selection: BoardSelectionEntry[];
  arrows: { from?: string; to?: string; label?: string }[];
}

/** What an agent writes into inbox/<id>.json to post a card back. */
export interface InboxIntent {
  type?: BoardCardKind;
  title?: string;
  body?: string;
  filePath?: string;
  anchor?: string;
  color?: string;
}

// ---- webview protocol ----

export type ExtToBoard =
  | { type: "fleet"; agents: AgentSummary[] }
  | { type: "board"; doc: BoardDoc }
  | { type: "addCard"; card: BoardCard }
  | { type: "meta"; showOlder: boolean; hiddenCount: number }
  | { type: "config"; boardDir: string; hooksReady: boolean }
  | { type: "teams"; snapshot: TeamSnapshot };

export type BoardToExt =
  | { type: "ready" }
  | { type: "saveBoard"; doc: BoardDoc }
  | {
      type: "selection";
      entries: BoardSelectionEntry[];
      arrows: { from?: string; to?: string; label?: string }[];
    }
  | { type: "pinDiff"; sessionId: string }
  | { type: "pinOutput"; sessionId: string }
  | { type: "focusAgent"; sessionId: string }
  | { type: "openDiff"; sessionId: string }
  | { type: "sendToAgent"; sessionId: string }
  | { type: "toggleOlder" }
  | { type: "newAgent" };
