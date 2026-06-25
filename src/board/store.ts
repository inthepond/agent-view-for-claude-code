import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { BoardDoc, BoardSelectionFile, InboxIntent, emptyBoard } from "./types";

function atomicWrite(file: string, data: string): void {
  const tmp = `${file}.${randomUUID().slice(0, 8)}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

const AGENT_GUIDE = `# Agent View — Pinboard bridge

This folder bridges Claude Code agents and the Agent View **Pinboard** canvas.
It is written/read by both the extension and your agents.

## Read what the user selected
\`selection.json\` (also at \`$AGENTVIEW_BOARD_DIR/selection.json\`) holds the
cards the user has selected for you — diffs, plans, notes — plus any arrows /
labels they drew. Read it to understand the request.

## Post a result card back onto the canvas
Drop a card on the board by writing \`inbox/<id>.json\`. Write it **atomically**
(a bare write can be read half-finished):

\`\`\`sh
echo '{ ... }' > inbox/result-1.json.tmp
mv inbox/result-1.json.tmp inbox/result-1.json
\`\`\`

Intent shape:

\`\`\`json
{ "type": "result", "title": "short title", "body": "markdown body", "filePath": "optional/path.ts" }
\`\`\`

The extension validates and places the card; on a bad write it leaves
\`inbox/<id>.error.json\` with the reason.
`;

/**
 * On-disk store for one Pinboard. State lives in the repo under
 * `.agentview/board/` so it is git-committable and travels with the branch.
 *
 *   pages/default.json  durable cards + arrows + camera (written by the webview)
 *   selection.json      the human's current selection (written by the host)
 *   inbox/<id>.json     agent-written result intents (watched by the host)
 *   assets/             de-base64'd image bytes (future)
 */
export class BoardStore {
  readonly dir: string;
  readonly pagesDir: string;
  readonly inboxDir: string;
  readonly assetsDir: string;
  private readonly docPath: string;
  private readonly selectionPath: string;
  private inboxWatcher?: fs.FSWatcher;
  private readonly seenInbox = new Set<string>();

  constructor(repoRootOrCwd: string) {
    this.dir = path.join(repoRootOrCwd, ".agentview", "board");
    this.pagesDir = path.join(this.dir, "pages");
    this.inboxDir = path.join(this.dir, "inbox");
    this.assetsDir = path.join(this.dir, "assets");
    this.docPath = path.join(this.pagesDir, "default.json");
    this.selectionPath = path.join(this.dir, "selection.json");
  }

  ensure(): void {
    for (const d of [this.dir, this.pagesDir, this.inboxDir, this.assetsDir]) {
      fs.mkdirSync(d, { recursive: true });
    }
    try {
      atomicWrite(path.join(this.dir, "README.md"), AGENT_GUIDE);
    } catch {
      /* best-effort */
    }
  }

  load(): BoardDoc {
    try {
      const doc = JSON.parse(fs.readFileSync(this.docPath, "utf8")) as BoardDoc;
      doc.cards = Array.isArray(doc.cards) ? doc.cards : [];
      doc.arrows = Array.isArray(doc.arrows) ? doc.arrows : [];
      return doc;
    } catch {
      return emptyBoard();
    }
  }

  save(doc: BoardDoc): void {
    this.ensure();
    atomicWrite(this.docPath, JSON.stringify(doc, null, 2));
  }

  writeSelection(file: BoardSelectionFile): void {
    this.ensure();
    atomicWrite(this.selectionPath, JSON.stringify(file, null, 2));
  }

  /** Watch inbox/ for agent-written intents; tolerant of partial writes. */
  watchInbox(onIntent: (intent: InboxIntent, id: string) => void): void {
    this.ensure();
    try {
      this.inboxWatcher = fs.watch(this.inboxDir, (_event, fname) => {
        if (!fname) return;
        const name = fname.toString();
        if (!name.endsWith(".json") || name.endsWith(".error.json")) return;
        if (this.seenInbox.has(name)) return;
        this.consumeInbox(name, onIntent, 0);
      });
    } catch {
      /* recursive/dir fs.watch unsupported — inbox loop disabled on this OS */
    }
  }

  private consumeInbox(
    name: string,
    onIntent: (intent: InboxIntent, id: string) => void,
    attempt: number,
  ): void {
    const full = path.join(this.inboxDir, name);
    setTimeout(() => {
      if (this.seenInbox.has(name)) return;
      let raw: string;
      try {
        if (!fs.existsSync(full)) return;
        raw = fs.readFileSync(full, "utf8");
      } catch {
        return;
      }
      let intent: InboxIntent;
      try {
        intent = JSON.parse(raw) as InboxIntent;
      } catch {
        if (attempt < 3) {
          this.consumeInbox(name, onIntent, attempt + 1); // likely a partial write — retry
          return;
        }
        try {
          atomicWrite(
            full.replace(/\.json$/, ".error.json"),
            JSON.stringify({ error: "invalid JSON", at: Date.now() }, null, 2),
          );
          fs.unlinkSync(full);
        } catch {
          /* ignore */
        }
        return;
      }
      this.seenInbox.add(name);
      const id = name.replace(/\.json$/, "");
      try {
        onIntent(intent, id);
      } finally {
        try {
          fs.unlinkSync(full);
        } catch {
          /* ignore */
        }
        setTimeout(() => this.seenInbox.delete(name), 5000);
      }
    }, 150);
  }

  dispose(): void {
    this.inboxWatcher?.close();
    this.inboxWatcher = undefined;
  }
}
