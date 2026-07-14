import * as vscode from "vscode";
import * as fs from "fs";
import { randomBytes } from "crypto";
import { AgentStore } from "../store";
import { AgentSession } from "../types";
import { readMessages } from "../transcript";
import { AgentSummary, ExtToWeb, RaceGroup, ReviewQueue, ViewMode, WebToExt } from "./protocol";
import { InsightsController } from "../features/insights";

function tokensTotal(a: AgentSession): number {
  const t = a.tokens;
  return t.input + t.output + t.cacheRead + t.cacheCreate;
}

function toSummary(a: AgentSession): AgentSummary {
  return {
    sessionId: a.sessionId,
    label: a.label,
    status: a.status,
    statusSource: a.statusSource,
    model: a.model,
    gitBranch: a.gitBranch,
    tokensTotal: tokensTotal(a),
    lastActivity: a.lastActivity,
    messageCount: a.messageCount,
    lastAction: a.lastAction,
    liveAction: a.liveAction,
    plan: a.plan,
    lastError: a.lastError,
    acknowledged: a.acknowledged,
    managed: a.managed,
    kind: a.kind,
    parentId: a.parentId,
    agentType: a.agentType,
    groupId: a.groupId,
    groupRole: a.groupRole,
    activeSubagents: (a.subagents || []).filter(
      (s) => s.status === "running" || s.status === "waiting" || s.status === "thinking",
    ).length,
  };
}

export function flattenFleet(sessions: AgentSession[]): AgentSummary[] {
  const out: AgentSummary[] = [];
  for (const s of sessions) {
    out.push(toSummary(s));
    for (const sub of s.subagents || []) out.push(toSummary(sub));
  }
  return out;
}

/** Callbacks into the extension host for actions the webview can trigger. */
export interface WebviewHandlers {
  newAgent(): void;
  pickWinner(sessionId: string): void;
  openCandidateDiff(sessionId: string): void;
  openAllDiffs(groupId: string): void;
  rankRace(groupId: string): void;
  cleanupRace(groupId: string): void;
  fanOut(text: string): void;
  /** Build the current race snapshot (status/tokens/scores/winner) for a group. */
  buildRace(groupId: string): RaceGroup | null;
  /** Build the review-and-land queue (diff stats per managed agent). Async — it
   *  shells out to git, so it is computed on demand, not on every store change. */
  buildReviewQueue(): Promise<ReviewQueue>;
  openReviewDiff(sessionId: string): void;
  requestChanges(sessionId: string, comment: string): void;
  landAgent(sessionId: string): void;
  openPR(sessionId: string): void;
  copyMerge(sessionId: string): void;
  cleanupAgent(sessionId: string): void;
}

export class DetailViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "mas.detail";
  private view?: vscode.WebviewView;
  private selected: string | null = null;
  private mode: ViewMode = "detail";
  private activeRaceGroupId: string | null = null;
  private reviewTimer?: NodeJS.Timeout;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly store: AgentStore,
    private readonly insights: InsightsController,
    private readonly handlers: WebviewHandlers,
  ) {
    store.onDidChange(() => {
      this.postFleet();
      if (this.activeRaceGroupId) this.postRace();
      if (this.selected) this.postTranscript(this.selected);
      if (this.mode === "review") this.scheduleReview();
    });
    insights.onDidChange(() => this.postInsights());
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "webview-ui", "dist")],
    };
    view.webview.html = this.html(view.webview);

    view.webview.onDidReceiveMessage((msg: WebToExt) => {
      switch (msg.type) {
        case "ready":
          this.postFleet();
          this.postInsights();
          this.post({ type: "view", view: this.mode });
          if (this.activeRaceGroupId) this.postRace();
          if (this.mode === "review") this.postReview();
          break;
        case "refresh":
          this.store.refresh();
          break;
        case "newAgent":
          this.handlers.newAgent();
          break;
        case "select":
          this.select(msg.sessionId);
          break;
        case "setView":
          this.setView(msg.view);
          break;
        case "pickWinner":
          this.handlers.pickWinner(msg.sessionId);
          break;
        case "openCandidateDiff":
          this.handlers.openCandidateDiff(msg.sessionId);
          break;
        case "openAllDiffs":
          this.handlers.openAllDiffs(msg.groupId);
          break;
        case "rankRace":
          this.handlers.rankRace(msg.groupId);
          break;
        case "cleanupRace":
          this.handlers.cleanupRace(msg.groupId);
          break;
        case "fanOut":
          this.handlers.fanOut(msg.text);
          break;
        case "acknowledge":
          this.store.acknowledge(msg.sessionId);
          break;
        case "acknowledgeAll":
          this.store.acknowledgeAllNeedsYou();
          break;
        case "refreshReview":
          this.postReview();
          break;
        case "openReviewDiff":
          this.handlers.openReviewDiff(msg.sessionId);
          break;
        case "requestChanges":
          this.handlers.requestChanges(msg.sessionId, msg.comment);
          break;
        case "landAgent":
          this.handlers.landAgent(msg.sessionId);
          break;
        case "openPR":
          this.handlers.openPR(msg.sessionId);
          break;
        case "copyMerge":
          this.handlers.copyMerge(msg.sessionId);
          break;
        case "cleanupAgent":
          this.handlers.cleanupAgent(msg.sessionId);
          break;
      }
    });

    view.onDidDispose(() => {
      if (this.reviewTimer) {
        clearTimeout(this.reviewTimer);
        this.reviewTimer = undefined;
      }
      this.view = undefined;
    });
  }

  select(sessionId: string): void {
    this.selected = sessionId;
    this.setView("detail");
    this.post({ type: "selected", sessionId });
    this.postTranscript(sessionId);
  }

  setView(view: ViewMode): void {
    this.mode = view;
    this.post({ type: "view", view });
    if (view === "review") this.postReview();
  }

  /** Switch to the Review & Land surface and stream the queue. */
  openReview(): void {
    this.setView("review");
  }

  /** External review inputs changed (e.g. an evidence run finished) — refresh
   *  the queue if it's on screen. Debounced through the same review timer. */
  notifyReviewDataChanged(): void {
    if (this.mode === "review") this.scheduleReview();
  }

  private scheduleReview(): void {
    if (this.reviewTimer) clearTimeout(this.reviewTimer);
    this.reviewTimer = setTimeout(() => {
      if (this.mode === "review") this.postReview();
    }, 500);
  }

  private postReview(): void {
    if (this.reviewTimer) {
      clearTimeout(this.reviewTimer);
      this.reviewTimer = undefined;
    }
    void this.handlers
      .buildReviewQueue()
      .then((queue) => this.post({ type: "review", queue }))
      .catch(() => {
        /* best-effort — a transient git failure shouldn't crash the panel */
      });
  }

  /** Forget the active race (after the group's worktrees are cleaned up). */
  clearRace(): void {
    this.activeRaceGroupId = null;
    this.post({ type: "race", group: null });
    if (this.mode === "race") this.setView("detail");
  }

  /** Open the race view for a freshly-started group and stream live updates. */
  openRace(groupId: string): void {
    this.activeRaceGroupId = groupId;
    this.mode = "race";
    this.post({ type: "view", view: "race" });
    this.postRace();
  }

  openFanout(): void {
    this.setView("fanout");
  }

  /** Re-push the active race snapshot (after a rank or winner pick). */
  refreshRace(): void {
    if (this.activeRaceGroupId) this.postRace();
  }

  private postRace(): void {
    if (!this.activeRaceGroupId) return;
    const group = this.handlers.buildRace(this.activeRaceGroupId);
    // The group's agents left the registry (stopped / cleaned up elsewhere) —
    // don't strand the user on an empty race surface; fall back to detail.
    if (!group) {
      this.clearRace();
      return;
    }
    this.post({ type: "race", group });
  }

  private postFleet(): void {
    this.post({ type: "fleet", agents: flattenFleet(this.store.listVisible()) });
  }

  private postInsights(): void {
    this.post({ type: "insights", conflicts: this.insights.conflicts, router: this.insights.router });
  }

  private postTranscript(sessionId: string): void {
    const agent = this.store.getById(sessionId);
    if (!agent) return;
    this.post({ type: "transcript", sessionId, messages: readMessages(agent.jsonlPath) });
  }

  private post(msg: ExtToWeb): void {
    this.view?.webview.postMessage(msg);
  }

  private html(webview: vscode.Webview): string {
    const distUri = vscode.Uri.joinPath(this.extensionUri, "webview-ui", "dist");
    const indexPath = vscode.Uri.joinPath(distUri, "index.html").fsPath;

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

    // cspSource is needed alongside the nonce: Vite code-splits a shared vendor
    // chunk that the entry imports as an ES module, and a nonce only covers the
    // entry <script> — not the chunks it pulls in.
    const csp =
      `default-src 'none'; ` +
      `style-src ${webview.cspSource} 'unsafe-inline'; ` +
      `script-src 'nonce-${nonce}' ${webview.cspSource}; ` +
      `img-src ${webview.cspSource} https: data:; ` +
      `font-src ${webview.cspSource};`;
    const meta = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
    html = html.replace(/<head>/, `<head>\n  ${meta}`);

    return html;
  }

  private placeholder(): string {
    return `<!DOCTYPE html><html><head>
      <meta charset="utf-8">
      <style>
        body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 1rem; }
        code { background: var(--vscode-textCodeBlock-background); padding: 0 4px; border-radius: 3px; }
      </style></head><body>
      <h3>Agent View</h3>
      <p>The webview UI has not been built yet.</p>
      <p>Run <code>npm run build:webview</code> (or <code>npm run build</code>) and reload the window.</p>
      </body></html>`;
  }
}
