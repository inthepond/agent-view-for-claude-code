// Pinboard domain + webview protocol types (extension-host side).
// The webview mirror lives in webview-ui/src/board/protocol.ts (kept in sync
// manually — the two packages have separate tsconfig roots).
import type { AgentSummary } from "../webview/protocol";

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
  | { type: "config"; boardDir: string; hooksReady: boolean };

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
