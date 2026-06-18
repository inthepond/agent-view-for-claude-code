import * as vscode from "vscode";
import * as fs from "fs";
import { AgentSession, AgentStatus } from "./types";
import { discoverAgents } from "./discovery";
import { projectsDir } from "./paths";
import { Registry } from "./orchestrator/registry";

interface HookState {
  status: AgentStatus;
  at: number;
}

/** A "running"/"waiting" hook status older than this is no longer trusted. */
const HOOK_STATUS_TTL_MS = 45_000;
/** Periodic re-evaluation so stale statuses + relative times stay current. */
const HEARTBEAT_MS = 15_000;

/**
 * Central source of truth for the agent fleet. Merges on-disk discovery
 * (pull) with hook events (push), and emits a change whenever either updates.
 */
export class AgentStore {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  private agents: AgentSession[] = [];
  private readonly hookStatus = new Map<string, HookState>();
  private watcher?: fs.FSWatcher;
  private pollTimer?: NodeJS.Timeout;
  private heartbeat?: NodeJS.Timeout;
  private debounce?: NodeJS.Timeout;

  constructor(
    private readonly registry: Registry,
    private readonly getConfig: () => { recentDays: number },
  ) {}

  start(): void {
    this.refresh();
    this.watch();
    this.heartbeat = setInterval(() => this.refresh(), HEARTBEAT_MS);
  }

  dispose(): void {
    this.watcher?.close();
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.debounce) clearTimeout(this.debounce);
    this._onDidChange.dispose();
  }

  list(): AgentSession[] {
    return this.agents;
  }

  getById(id: string): AgentSession | undefined {
    for (const a of this.agents) {
      if (a.sessionId === id) return a;
      const sub = a.subagents?.find((s) => s.sessionId === id);
      if (sub) return sub;
    }
    return undefined;
  }

  refresh(): void {
    const cfg = this.getConfig();
    const found = discoverAgents({
      recentDays: cfg.recentDays,
      managedLookup: (id) => {
        const m = this.registry.get(id);
        return m ? { worktreePath: m.worktreePath, label: m.label } : undefined;
      },
    });

    // Hook status is authoritative over the JSONL heuristic, EXCEPT a stale
    // "running"/"waiting": if we got a PreToolUse but never the matching Stop
    // (server restart, missed event, port held by another window), it would
    // otherwise pin the agent forever. Age those out and trust the transcript.
    for (const a of found) {
      const hs = this.hookStatus.get(a.sessionId);
      if (!hs) continue;
      const stale = Date.now() - hs.at > HOOK_STATUS_TTL_MS;
      const transient = hs.status === "running" || hs.status === "waiting";
      if (transient && stale) {
        this.hookStatus.delete(a.sessionId); // forget it; rely on the heuristic
        continue;
      }
      a.status = hs.status;
      a.statusSource = "hook";
    }

    this.agents = found;
    this._onDidChange.fire();
  }

  /** Called by the hook server when a Claude Code event arrives. */
  applyHookStatus(sessionId: string, status: AgentStatus): void {
    this.hookStatus.set(sessionId, { status, at: Date.now() });
    const a = this.agents.find((x) => x.sessionId === sessionId);
    if (a) {
      a.status = status;
      a.statusSource = "hook";
      this._onDidChange.fire();
    } else {
      this.scheduleRefresh();
    }
  }

  private watch(): void {
    try {
      this.watcher = fs.watch(projectsDir(), { recursive: true }, () => this.scheduleRefresh());
    } catch {
      // Recursive fs.watch is unsupported on Linux — fall back to polling.
      this.pollTimer = setInterval(() => this.refresh(), 4000);
    }
  }

  private scheduleRefresh(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.refresh(), 400);
  }
}
