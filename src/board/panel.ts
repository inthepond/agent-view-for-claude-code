import * as vscode from "vscode";
import * as fs from "fs";
import { randomBytes, randomUUID } from "crypto";
import { AgentStore } from "../store";
import { flattenFleet } from "../webview/provider";
import { BoardStore } from "./store";
import {
  BoardCard,
  BoardSelectionFile,
  BoardToExt,
  ExtToBoard,
  InboxIntent,
  TeamSnapshot,
} from "./types";

export interface CapturedDiff {
  diffText: string;
  branch?: string;
  commit?: string;
  baseRef?: string;
  label?: string;
}

export interface BoardDeps {
  focusAgent(id: string): void;
  openDiff(id: string): void;
  newAgent(): void;
  captureDiff(sessionId: string): Promise<CapturedDiff | null>;
  captureOutput(sessionId: string): { title: string; body: string } | null;
  sendToAgent(sessionId: string, summary: string): void;
  hooksReady(): boolean;
  /** Live snapshot of the active team (roster + task graph) for the cockpit. */
  buildTeams(): TeamSnapshot;
}

/**
 * The Pinboard — a standalone editor-area WebviewPanel. It is intentionally
 * independent of the sidebar DetailViewProvider (own state, own message
 * handler) so adding it requires no shared-state refactor; for "focus this
 * agent" it just calls back into the existing detail.select via deps.
 */
export class BoardPanel {
  static readonly viewType = "mas.board";
  static current?: BoardPanel;

  private readonly disposables: vscode.Disposable[] = [];
  private lastSelectionSummary = "";
  private teamsTimer?: NodeJS.Timeout;

  static createOrShow(
    extensionUri: vscode.Uri,
    store: AgentStore,
    boardStore: BoardStore,
    deps: BoardDeps,
  ): void {
    if (BoardPanel.current) {
      BoardPanel.current.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      BoardPanel.viewType,
      "Pinboard",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "webview-ui", "dist")],
      },
    );
    BoardPanel.current = new BoardPanel(panel, extensionUri, store, boardStore, deps);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private readonly store: AgentStore,
    private readonly boardStore: BoardStore,
    private readonly deps: BoardDeps,
  ) {
    boardStore.ensure();
    panel.webview.html = this.html(panel.webview);

    this.disposables.push(
      this.store.onDidChange(() => {
        this.postFleet();
        this.postMeta();
        this.scheduleTeams();
      }),
    );
    boardStore.watchInbox((intent, id) => this.onInbox(intent, id));

    panel.webview.onDidReceiveMessage(
      (msg: BoardToExt) => this.onMessage(msg),
      null,
      this.disposables,
    );
    panel.onDidDispose(() => this.cleanup(), null, this.disposables);
  }

  private onMessage(msg: BoardToExt): void {
    switch (msg.type) {
      case "ready":
        this.post({ type: "config", boardDir: this.boardStore.dir, hooksReady: this.deps.hooksReady() });
        this.post({ type: "board", doc: this.boardStore.load() });
        this.postFleet();
        this.postMeta();
        this.postTeams();
        break;
      case "toggleOlder":
        this.store.setShowOlder(!this.store.showingOlder);
        break;
      case "saveBoard":
        try {
          this.boardStore.save(msg.doc);
        } catch {
          /* best-effort persistence */
        }
        break;
      case "selection":
        this.lastSelectionSummary =
          msg.entries.map((e) => e.title).filter(Boolean).join("; ") || "(no cards)";
        try {
          const file: BoardSelectionFile = {
            version: 1,
            updatedAt: Date.now(),
            canvasOpen: true,
            selection: msg.entries,
            arrows: msg.arrows,
          };
          this.boardStore.writeSelection(file);
        } catch {
          /* ignore */
        }
        break;
      case "pinDiff":
        void this.pin(msg.sessionId);
        break;
      case "pinOutput":
        this.pinOutput(msg.sessionId);
        break;
      case "focusAgent":
        this.deps.focusAgent(msg.sessionId);
        break;
      case "openDiff":
        this.deps.openDiff(msg.sessionId);
        break;
      case "sendToAgent":
        this.deps.sendToAgent(msg.sessionId, this.lastSelectionSummary);
        break;
      case "newAgent":
        this.deps.newAgent();
        break;
    }
  }

  private async pin(sessionId: string): Promise<void> {
    const d = await this.deps.captureDiff(sessionId);
    if (!d) {
      vscode.window.showWarningMessage(
        "Agent View: a diff to pin is only available for Agent View-spawned worktree agents.",
      );
      return;
    }
    const card: BoardCard = {
      id: `card_${randomUUID().slice(0, 8)}`,
      kind: "diff",
      title: d.label || d.branch || "diff",
      diffText: d.diffText || "(no changes yet)",
      branch: d.branch,
      pinnedAtCommit: d.commit,
      baseRef: d.baseRef,
      sourceSessionId: sessionId,
      x: 0,
      y: 0,
      createdBy: "human",
      createdAt: Date.now(),
    };
    this.post({ type: "addCard", card });
  }

  private pinOutput(sessionId: string): void {
    const o = this.deps.captureOutput(sessionId);
    if (!o) {
      vscode.window.showWarningMessage("Agent View: no output to pin for that agent yet.");
      return;
    }
    const card: BoardCard = {
      id: `card_${randomUUID().slice(0, 8)}`,
      kind: "output",
      title: o.title,
      body: o.body,
      sourceSessionId: sessionId,
      x: 0,
      y: 0,
      createdBy: "human",
      createdAt: Date.now(),
    };
    this.post({ type: "addCard", card });
  }

  private onInbox(intent: InboxIntent, id: string): void {
    const kinds = ["result", "note", "doc", "output", "image", "diff"];
    const kind = intent.type && kinds.includes(intent.type) ? intent.type : "result";
    const card: BoardCard = {
      id: `card_${id.slice(0, 12)}`,
      kind,
      title: (intent.title || "Agent result").slice(0, 120),
      body: intent.body,
      filePath: intent.filePath,
      x: 0,
      y: 0,
      createdBy: "agent",
      createdAt: Date.now(),
    };
    this.post({ type: "addCard", card });
  }

  private postFleet(): void {
    this.post({ type: "fleet", agents: flattenFleet(this.store.listVisible()) });
  }

  private postMeta(): void {
    this.post({ type: "meta", showOlder: this.store.showingOlder, hiddenCount: this.store.hiddenCount() });
  }

  // Building the team snapshot scans subagent sidecars + a transcript per
  // candidate lead, so debounce it instead of running on every store tick.
  private scheduleTeams(): void {
    if (this.teamsTimer) clearTimeout(this.teamsTimer);
    this.teamsTimer = setTimeout(() => this.postTeams(), 500);
  }

  private postTeams(): void {
    if (this.teamsTimer) {
      clearTimeout(this.teamsTimer);
      this.teamsTimer = undefined;
    }
    try {
      this.post({ type: "teams", snapshot: this.deps.buildTeams() });
    } catch {
      /* best-effort — a transient fs/parse failure shouldn't break the panel */
    }
  }

  private post(msg: ExtToBoard): void {
    void this.panel.webview.postMessage(msg);
  }

  private cleanup(): void {
    BoardPanel.current = undefined;
    if (this.teamsTimer) {
      clearTimeout(this.teamsTimer);
      this.teamsTimer = undefined;
    }
    try {
      this.boardStore.writeSelection({
        version: 1,
        updatedAt: Date.now(),
        canvasOpen: false,
        selection: [],
        arrows: [],
      });
    } catch {
      /* ignore */
    }
    this.boardStore.dispose();
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }

  private html(webview: vscode.Webview): string {
    const distUri = vscode.Uri.joinPath(this.extensionUri, "webview-ui", "dist");
    const indexPath = vscode.Uri.joinPath(distUri, "board.html").fsPath;

    let html: string;
    try {
      html = fs.readFileSync(indexPath, "utf8");
    } catch {
      return this.placeholder();
    }

    const base = webview.asWebviewUri(distUri).toString();
    const nonce = randomBytes(16).toString("base64");

    html = html.replace(/(href|src)="(\.?\/)?(assets\/[^"]+)"/g, (_m, attr, _p, p) => {
      return `${attr}="${base}/${p}"`;
    });
    html = html.replace(/<script /g, `<script nonce="${nonce}" `);

    // cspSource alongside the nonce: Vite code-splits a shared vendor chunk the
    // entry imports as an ES module, which a nonce alone cannot authorise.
    const csp =
      `default-src 'none'; ` +
      `style-src ${webview.cspSource} 'unsafe-inline'; ` +
      `script-src 'nonce-${nonce}' ${webview.cspSource}; ` +
      `img-src ${webview.cspSource} https: data: blob:; ` +
      `font-src ${webview.cspSource};`;
    const meta = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
    html = html.replace(/<head>/, `<head>\n  ${meta}`);

    return html;
  }

  private placeholder(): string {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 1rem; }
      code { background: var(--vscode-textCodeBlock-background); padding: 0 4px; border-radius: 3px; }
      </style></head><body>
      <h3>Pinboard</h3>
      <p>The webview UI has not been built yet.</p>
      <p>Run <code>npm run build</code> and reopen the Pinboard.</p>
      </body></html>`;
  }
}
