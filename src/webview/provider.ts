import * as vscode from "vscode";
import * as fs from "fs";
import { randomBytes } from "crypto";
import { AgentStore } from "../store";
import { AgentSession } from "../types";
import { readMessages } from "../transcript";
import { AgentSummary, ExtToWeb, WebToExt } from "./protocol";
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
    managed: a.managed,
    kind: a.kind,
    parentId: a.parentId,
    agentType: a.agentType,
  };
}

function flattenFleet(sessions: AgentSession[]): AgentSummary[] {
  const out: AgentSummary[] = [];
  for (const s of sessions) {
    out.push(toSummary(s));
    for (const sub of s.subagents || []) out.push(toSummary(sub));
  }
  return out;
}

export class DetailViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = "mas.detail";
  private view?: vscode.WebviewView;
  private selected: string | null = null;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly store: AgentStore,
    private readonly insights: InsightsController,
    private readonly onNewAgent: () => void,
  ) {
    store.onDidChange(() => {
      this.postFleet();
      if (this.selected) this.postTranscript(this.selected);
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
          break;
        case "refresh":
          this.store.refresh();
          break;
        case "newAgent":
          this.onNewAgent();
          break;
        case "select":
          this.select(msg.sessionId);
          break;
      }
    });
  }

  select(sessionId: string): void {
    this.selected = sessionId;
    this.post({ type: "selected", sessionId });
    this.postTranscript(sessionId);
  }

  private postFleet(): void {
    this.post({ type: "fleet", agents: flattenFleet(this.store.list()) });
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

    const csp =
      `default-src 'none'; ` +
      `style-src ${webview.cspSource} 'unsafe-inline'; ` +
      `script-src 'nonce-${nonce}'; ` +
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
