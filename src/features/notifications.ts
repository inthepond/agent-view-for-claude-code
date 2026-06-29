import * as vscode from "vscode";
import { exec } from "child_process";
import { AgentStatus } from "../types";
import { AgentStore } from "../store";

export interface NotificationConfig {
  enabled: boolean;
  sound: boolean;
  onWaiting: boolean;
  onDone: boolean;
  onError: boolean;
}

/** Actions the toast buttons invoke, wired by the extension host. */
export interface NotificationActions {
  focus(sessionId: string): void;
  reveal(sessionId: string): void;
  openDiff(sessionId: string): void;
}

/** A managed agent that goes idle must stay idle this long before we call it
 *  "finished" — avoids pinging on a brief run -> idle -> run between turns. */
const FINISH_DEBOUNCE_MS = 4000;

/**
 * Watches the fleet for the transitions worth interrupting the user over:
 *   - any session -> waiting        ("needs your input")
 *   - a managed agent running -> idle/done, sustained  ("finished")
 *   - any session -> error          ("hit an error")
 *
 * Subagents are ignored so a fan-out finishing doesn't fire a burst of toasts.
 */
export class NotificationController {
  private readonly lastStatus = new Map<string, AgentStatus>();
  private readonly finishTimers = new Map<string, NodeJS.Timeout>();
  private readonly notifiedDone = new Set<string>();
  private sub?: vscode.Disposable;

  constructor(
    private readonly store: AgentStore,
    private readonly getConfig: () => NotificationConfig,
    private readonly actions: NotificationActions,
  ) {}

  start(): void {
    this.sub = this.store.onDidChange(() => this.onChange());
  }

  dispose(): void {
    this.sub?.dispose();
    for (const t of this.finishTimers.values()) clearTimeout(t);
    this.finishTimers.clear();
    this.lastStatus.clear();
    this.notifiedDone.clear();
  }

  private onChange(): void {
    const cfg = this.getConfig();
    const live = new Set<string>();
    for (const a of this.store.list()) {
      if (a.kind !== "session") continue; // ignore subagents (burst control)
      live.add(a.sessionId);

      const prev = this.lastStatus.get(a.sessionId);
      this.lastStatus.set(a.sessionId, a.status);
      if (prev === undefined || prev === a.status) continue;

      // Back to work: cancel a pending "finished" ping (it was a mid-task
      // blip). We deliberately do NOT re-arm notifiedDone — "finished" fires
      // at most once per agent, so an interactive agent the user keeps
      // chatting with doesn't ping on every turn's idle.
      if (a.status === "running") {
        const t = this.finishTimers.get(a.sessionId);
        if (t) {
          clearTimeout(t);
          this.finishTimers.delete(a.sessionId);
        }
      }

      if (!cfg.enabled) continue;

      if (a.status === "waiting" && prev !== "waiting" && cfg.onWaiting && !a.acknowledged) {
        this.fire(a.sessionId, `${a.label} needs your input`, "waiting", a.managed);
      } else if (a.status === "error" && prev !== "error" && cfg.onError && !a.acknowledged) {
        this.fire(a.sessionId, `${a.label} hit an error`, "error", a.managed);
      } else if (
        (a.status === "done" || a.status === "idle") &&
        (prev === "running" || prev === "waiting" || prev === "thinking") &&
        cfg.onDone &&
        a.managed &&
        !a.acknowledged // a dismissal flips waiting->idle; that isn't "finished"
      ) {
        this.scheduleFinish(a.sessionId, a.label);
      }
    }
    // Drop tracking for sessions that aged out of discovery (bounded growth).
    for (const id of this.lastStatus.keys()) if (!live.has(id)) this.lastStatus.delete(id);
    for (const id of this.notifiedDone) if (!live.has(id)) this.notifiedDone.delete(id);
    for (const [id, t] of this.finishTimers) {
      if (!live.has(id)) {
        clearTimeout(t);
        this.finishTimers.delete(id);
      }
    }
  }

  private scheduleFinish(sessionId: string, label: string): void {
    if (this.notifiedDone.has(sessionId)) return;
    const existing = this.finishTimers.get(sessionId);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      this.finishTimers.delete(sessionId);
      const a = this.store.getById(sessionId);
      if (!a || a.status === "running" || a.status === "thinking") return; // resumed — not finished after all
      this.notifiedDone.add(sessionId);
      if (this.getConfig().enabled) {
        this.fire(sessionId, `${label} finished`, "done", true);
      }
    }, FINISH_DEBOUNCE_MS);
    this.finishTimers.set(sessionId, t);
  }

  private fire(sessionId: string, text: string, kind: ChimeKind, managed: boolean): void {
    if (this.getConfig().sound) playChime(kind);
    const buttons = managed ? ["Focus", "Open Diff"] : ["Show"];
    vscode.window.showInformationMessage(text, ...buttons).then((pick) => {
      if (pick === "Focus") this.actions.focus(sessionId);
      else if (pick === "Open Diff") this.actions.openDiff(sessionId);
      else if (pick === "Show") this.actions.reveal(sessionId);
    });
  }
}

type ChimeKind = "waiting" | "error" | "done";

/** Best-effort OS chime. Per-platform shell-out; failures are swallowed so a
 *  missing player or a sandboxed/SSH session never breaks notifications. */
function playChime(kind: ChimeKind): void {
  try {
    if (process.platform === "darwin") {
      const sound = kind === "done" ? "Glass" : kind === "error" ? "Basso" : "Funk";
      exec(`afplay /System/Library/Sounds/${sound}.aiff`, () => {});
    } else if (process.platform === "linux") {
      const file = kind === "done" ? "complete" : kind === "error" ? "dialog-error" : "message";
      exec(`paplay /usr/share/sounds/freedesktop/stereo/${file}.oga`, () => {});
    } else if (process.platform === "win32") {
      const s = kind === "error" ? "Hand" : kind === "done" ? "Asterisk" : "Exclamation";
      exec(`powershell -NoProfile -Command [System.Media.SystemSounds]::${s}.Play()`, () => {});
    }
  } catch {
    /* best-effort */
  }
}
