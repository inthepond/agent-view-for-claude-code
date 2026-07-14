import * as vscode from "vscode";

/** How long a file stays "being edited" after its last edit event — matches
 *  the hook-status TTL so presence and status age out together. */
const PRESENCE_TTL_MS = 45_000;

/** Hook tool names whose tool_input carries a file being written. */
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** Pull the edited file's absolute path out of a PreToolUse hook event. */
export function editedFileOf(event: any): string | undefined {
  if ((event?.hook_event_name || event?.hookEventName) !== "PreToolUse") return undefined;
  if (!EDIT_TOOLS.has(event?.tool_name || "")) return undefined;
  const input = event?.tool_input;
  const p = input?.file_path || input?.notebook_path;
  return typeof p === "string" && p.length > 0 ? p : undefined;
}

interface Touch {
  sessionId: string;
  label: string;
  at: number;
}

/**
 * Live presence: Explorer/tab badges on files an agent is editing RIGHT NOW,
 * driven by PreToolUse hook events. Decorations age out after a short TTL and
 * are cleared when the session stops. Only paths inside the current workspace
 * folders are decorated — an agent's worktree files show at their real
 * worktree paths, never conflated with the user's checkout.
 */
export class PresenceTracker implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly _onDidChangeFileDecorations = new vscode.EventEmitter<
    vscode.Uri | vscode.Uri[] | undefined
  >();
  readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

  /** fsPath -> latest touch. One agent per file is enough for a badge. */
  private readonly touches = new Map<string, Touch>();
  private sweepTimer?: NodeJS.Timeout;
  private registration?: vscode.Disposable;

  constructor(
    private readonly getEnabled: () => boolean,
    private readonly labelOf: (sessionId: string) => string,
  ) {}

  start(): void {
    this.registration = vscode.window.registerFileDecorationProvider(this);
    // Lazy sweep: only ticks while something is decorated.
  }

  dispose(): void {
    if (this.sweepTimer) clearTimeout(this.sweepTimer);
    this.registration?.dispose();
    this._onDidChangeFileDecorations.dispose();
    this.touches.clear();
  }

  /** Feed a raw hook event; no-ops unless it's an edit-tool PreToolUse. */
  onHookEvent(event: any): void {
    if (!this.getEnabled()) return;
    const sessionId = event?.session_id || event?.sessionId;
    if (!sessionId) return;
    const name = event?.hook_event_name || event?.hookEventName;
    if (name === "Stop" || name === "SessionEnd") {
      this.clearSession(sessionId);
      return;
    }
    const file = editedFileOf(event);
    if (!file) return;
    const uri = vscode.Uri.file(file);
    // Rapid same-file edit storms are the hot path: refreshing the timestamp
    // is enough (TTL is read at query time) — no label lookup, no re-fire.
    const prev = this.touches.get(uri.fsPath);
    if (prev && prev.sessionId === sessionId) {
      prev.at = Date.now();
      return;
    }
    // Presence is an editor affordance — only badge what the Explorer can show.
    if (!vscode.workspace.getWorkspaceFolder(uri)) return;
    this.touches.set(uri.fsPath, {
      sessionId,
      label: this.labelOf(sessionId),
      at: Date.now(),
    });
    this._onDidChangeFileDecorations.fire(uri);
    this.armSweep();
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (!this.getEnabled()) return undefined;
    const t = this.touches.get(uri.fsPath);
    if (!t || Date.now() - t.at > PRESENCE_TTL_MS) return undefined;
    const deco = new vscode.FileDecoration(
      "AI",
      `${t.label} is editing this file now`,
      new vscode.ThemeColor("charts.blue"),
    );
    deco.propagate = false;
    return deco;
  }

  private clearSession(sessionId: string): void {
    const cleared: vscode.Uri[] = [];
    for (const [fsPath, t] of this.touches) {
      if (t.sessionId === sessionId) {
        this.touches.delete(fsPath);
        cleared.push(vscode.Uri.file(fsPath));
      }
    }
    if (cleared.length) this._onDidChangeFileDecorations.fire(cleared);
  }

  /** Re-fire decorations for expired entries so badges actually fade. */
  private armSweep(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setTimeout(() => {
      this.sweepTimer = undefined;
      const now = Date.now();
      const expired: vscode.Uri[] = [];
      for (const [fsPath, t] of this.touches) {
        if (now - t.at > PRESENCE_TTL_MS) {
          this.touches.delete(fsPath);
          expired.push(vscode.Uri.file(fsPath));
        }
      }
      if (expired.length) this._onDidChangeFileDecorations.fire(expired);
      if (this.touches.size > 0) this.armSweep();
    }, 5_000);
  }
}
