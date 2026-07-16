import * as vscode from "vscode";
import * as fs from "fs";
import { randomBytes } from "crypto";
import { AgentStore } from "../store";
import { flattenFleet } from "../webview/provider";
import { BoardStore } from "./store";
import { materializeSession } from "./materialize";
import {
  BoardObjectRef,
  BoardSelectionFile,
  BoardToExt,
  ExtToBoard,
  TeamSnapshot,
} from "./types";

export interface BoardDeps {
  focusAgent(id: string): void;
  openDiff(id: string): void;
  newAgent(): void;
  sendToAgent(sessionId: string, summary: string): void;
  hooksReady(): boolean;
  /** Live snapshot of the active team (roster + task graph) for the cockpit. */
  buildTeams(): TeamSnapshot;
}

/**
 * The Session Board — a standalone editor-area WebviewPanel that renders any
 * session as materialized board objects (episodes, plans, commits, evidence)
 * instead of a scroll. It is intentionally independent of the sidebar
 * DetailViewProvider (own state, own message handler); for "focus this agent"
 * it calls back into the existing detail.select via deps.
 */
export class BoardPanel {
  static readonly viewType = "mas.board";
  static current?: BoardPanel;

  private readonly disposables: vscode.Disposable[] = [];
  private teamsTimer?: NodeJS.Timeout;
  private boardTimer?: NodeJS.Timeout;
  private selectedSessionId: string | null = null;
  /** lastActivity of the selected session at the time it was materialized —
   *  a store tick only re-materializes when the transcript actually moved. */
  private materializedAt = 0;

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
      "Session Board",
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
        this.scheduleBoard();
      }),
    );

    // Agents that post inbox intents (the old canvas honored them as cards)
    // now surface as a notification — the board itself is materialized, so
    // their actual work already shows up without posting.
    boardStore.watchInbox((intent) => {
      const title = (intent.title || "Agent result").slice(0, 80);
      const body = (intent.body || "").slice(0, 200);
      vscode.window.showInformationMessage(
        `Session Board: an agent posted "${title}"${body ? ` — ${body}` : ""}`,
      );
    });

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
        this.postFleet();
        this.postMeta();
        this.postTeams();
        this.postBoard();
        break;
      case "selectSession":
        this.selectedSessionId = msg.sessionId;
        this.materializedAt = 0;
        this.postBoard();
        break;
      case "toggleOlder":
        this.store.setShowOlder(!this.store.showingOlder);
        break;
      case "sendToAgent":
        this.sendObjects(msg.sessionId, msg.objects);
        break;
      case "focusAgent":
        this.deps.focusAgent(msg.sessionId);
        break;
      case "openDiff":
        this.deps.openDiff(msg.sessionId);
        break;
      case "newAgent":
        this.deps.newAgent();
        break;
    }
  }

  /** Selection travels the same envelope the Pinboard used (selection.json),
   *  so agent-side instructions that already read it keep working. */
  private sendObjects(sessionId: string, objects: BoardObjectRef[]): void {
    const summary = objects.map((o) => `${o.kind}: ${o.title}`).join("; ").slice(0, 400) || "(nothing)";
    try {
      const file: BoardSelectionFile = {
        version: 1,
        updatedAt: Date.now(),
        canvasOpen: true,
        selection: objects.map((o, i) => ({
          cardId: `${o.kind}_${o.episode ?? 0}_${i}`,
          kind: o.kind,
          title: o.title,
          body: o.detail,
          sourceSessionId: sessionId,
        })),
        arrows: [],
      };
      this.boardStore.writeSelection(file);
    } catch {
      /* best-effort — the terminal prompt still carries the summary */
    }
    this.deps.sendToAgent(sessionId, summary);
  }

  private postBoard(): void {
    if (this.boardTimer) {
      clearTimeout(this.boardTimer);
      this.boardTimer = undefined;
    }
    if (!this.selectedSessionId) {
      this.post({ type: "sessionBoard", board: null });
      return;
    }
    const agent = this.store.getById(this.selectedSessionId);
    if (!agent) {
      this.post({ type: "sessionBoard", board: null });
      return;
    }
    this.materializedAt = agent.lastActivity;
    const board = materializeSession(agent.jsonlPath, {
      sessionId: agent.sessionId,
      label: agent.label,
      gitBranch: agent.gitBranch,
    });
    this.post({ type: "sessionBoard", board });
  }

  // Materializing re-reads the whole transcript, so debounce store ticks and
  // skip entirely when the selected session hasn't moved.
  private scheduleBoard(): void {
    if (!this.selectedSessionId) return;
    const agent = this.store.getById(this.selectedSessionId);
    if (!agent || agent.lastActivity === this.materializedAt) return;
    if (this.boardTimer) clearTimeout(this.boardTimer);
    this.boardTimer = setTimeout(() => this.postBoard(), 1200);
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
    if (this.boardTimer) {
      clearTimeout(this.boardTimer);
      this.boardTimer = undefined;
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
      <h3>Session Board</h3>
      <p>The webview UI has not been built yet.</p>
      <p>Run <code>npm run build</code> and reopen the Session Board.</p>
      </body></html>`;
  }
}
