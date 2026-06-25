// Mirror of src/board/types.ts (kept in sync manually — separate tsconfig roots).
import type { AgentSummary } from "../protocol";

export type { AgentSummary };

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
