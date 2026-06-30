// Mirror of src/board/types.ts (kept in sync manually — separate tsconfig roots).
import type { AgentSummary, AgentStatus } from "../protocol";

export type { AgentSummary };

// ---- Teams cockpit ----

export type TeamTaskStatus = "pending" | "in_progress" | "completed";

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

export interface TeamTask {
  id: string;
  content: string;
  status: TeamTaskStatus;
  owner?: string;
  dependsOn: string[];
}

export interface TeamWorkflowRun {
  id: string;
  agentCount: number;
}

export interface Team {
  leadSessionId: string;
  leadLabel: string;
  members: TeamMember[];
  tasks: TeamTask[];
  workflowRuns: TeamWorkflowRun[];
}

export interface TeamSnapshot {
  present: boolean;
  source: "native" | "todowrite" | "none";
  /** All active teams, most-recently-active first. */
  teams: Team[];
  nativeStoreDetected: boolean;
}

export type BoardCardKind = "diff" | "note" | "doc" | "output" | "image" | "result";

export interface BoardCard {
  id: string;
  kind: BoardCardKind;
  title: string;
  body?: string;
  diffText?: string;
  branch?: string;
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

export interface BoardDoc {
  version: number;
  cards: BoardCard[];
  arrows: BoardArrow[];
  camera?: BoardCamera;
  updatedAt: number;
}

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
