import * as vscode from "vscode";
import { AgentStore } from "../store";
import { Conflict, RouterItem } from "../webview/protocol";
import { computeConflicts } from "./conflicts";
import { rulesRouter, aiRouter } from "./router";
import { requireLlmConsent } from "./consent";

export interface InsightsConfig {
  conflictRadar: boolean;
  attentionRouter: boolean;
  claudePath: string;
  triageModel: string;
}

/**
 * Owns the always-available (Conflict Radar) and AI (Attention Router) insights.
 * Conflicts are recomputed synchronously on every store change; the router runs
 * a debounced headless-Claude pass only when enabled + consented.
 */
export class InsightsController {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  conflicts: Conflict[] = [];
  router: RouterItem[] = [];

  private debounce?: NodeJS.Timeout;
  private running = false;
  private declined = false;

  constructor(
    private readonly store: AgentStore,
    private readonly context: vscode.ExtensionContext,
    private readonly getConfig: () => InsightsConfig,
  ) {}

  start(): void {
    this.store.onDidChange(() => this.onStoreChange());
    this.onStoreChange();
  }

  private onStoreChange(): void {
    const cfg = this.getConfig();
    // Only flag collisions among currently-active or MAS-managed agents — not
    // every session that ever touched the file over the recent-history window.
    const live = this.store
      .list()
      .filter((s) => s.managed || s.status === "running" || s.status === "waiting");
    this.conflicts = cfg.conflictRadar ? computeConflicts(live) : [];
    if (!cfg.attentionRouter) this.router = [];
    this._onDidChange.fire();
    if (cfg.attentionRouter && !this.declined) this.scheduleRouter();
  }

  private scheduleRouter(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.runRouter(), 1500);
  }

  private async runRouter(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const cfg = this.getConfig();
      if (!cfg.attentionRouter) return;

      if (!(await requireLlmConsent(this.context))) {
        this.declined = true;
        await vscode.workspace
          .getConfiguration("mas")
          .update("attentionRouter.enabled", false, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(
          "Attention Router turned off (AI usage not enabled). Re-enable it in settings any time.",
        );
        this.router = [];
        this._onDidChange.fire();
        return;
      }

      const sessions = this.store.list();
      let items: RouterItem[];
      try {
        items = await aiRouter(sessions, cfg.claudePath, cfg.triageModel);
      } catch {
        items = rulesRouter(sessions); // graceful fallback to free rules
      }
      // Honor manual dismissals regardless of what the LLM decided.
      this.router = items.map((it) =>
        this.store.isAcknowledged(it.sessionId)
          ? { ...it, urgency: "ok" as const, reason: "Dismissed — resurfaces on new activity." }
          : it,
      );
      this._onDidChange.fire();
    } finally {
      this.running = false;
    }
  }

  dispose(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this._onDidChange.dispose();
  }
}
