import * as vscode from "vscode";

const CTRL_C = "\u0003";

/** Tracks the integrated terminal backing each spawned agent. */
class TerminalManager {
  private readonly terminals = new Map<string, vscode.Terminal>();

  register(sessionId: string, terminal: vscode.Terminal): void {
    this.terminals.set(sessionId, terminal);
  }

  /** Resolve a terminal by session id, falling back to a name match. */
  find(sessionId: string, name?: string): vscode.Terminal | undefined {
    const t = this.terminals.get(sessionId);
    if (t && !isClosed(t)) return t;
    if (name) {
      return vscode.window.terminals.find((term) => term.name === name);
    }
    return undefined;
  }

  focus(sessionId: string, name?: string): boolean {
    const t = this.find(sessionId, name);
    if (t) {
      t.show(false);
      return true;
    }
    return false;
  }

  /** Type a line into the agent's terminal (e.g. push a Pinboard request). */
  sendText(sessionId: string, text: string, name?: string): boolean {
    const t = this.find(sessionId, name);
    if (!t) return false;
    t.show(false);
    t.sendText(text);
    return true;
  }

  /** Send Ctrl-C and dispose the agent's terminal. */
  stop(sessionId: string, name?: string): void {
    const t = this.find(sessionId, name);
    if (!t) return;
    try {
      t.sendText(CTRL_C, false); // interrupt the running agent
    } catch {
      /* ignore */
    }
    t.dispose();
    this.terminals.delete(sessionId);
  }

  dispose(): void {
    this.terminals.clear();
  }
}

function isClosed(t: vscode.Terminal): boolean {
  return t.exitStatus !== undefined;
}

export const terminals = new TerminalManager();
