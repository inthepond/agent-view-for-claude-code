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

interface LiveActionState {
  action: string;
  at: number;
}

/** A hook status older than this is no longer trusted (fall back to JSONL). */
const HOOK_STATUS_TTL_MS = 45_000;
/** A live "now doing X" phrase older than this is dropped (tool likely done). */
const LIVE_ACTION_TTL_MS = 20_000;
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
  private readonly liveAction = new Map<string, LiveActionState>();
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
        return m
          ? { worktreePath: m.worktreePath, label: m.label, groupId: m.groupId, groupRole: m.groupRole }
          : undefined;
      },
    });

    // Hook status is authoritative over the JSONL heuristic, EXCEPT when it's
    // stale or the transcript shows newer activity. Without the matching Stop
    // (server restart, missed event, port held by another window, or a session
    // resumed via a path the hook server never saw) a hook status would
    // otherwise pin the agent forever — including terminal idle/done/error.
    const liveIds = new Set<string>();
    for (const a of found) {
      liveIds.add(a.sessionId);
      const hs = this.hookStatus.get(a.sessionId);
      if (!hs) continue;
      const stale = Date.now() - hs.at > HOOK_STATUS_TTL_MS;
      const supersededByJsonl = a.lastActivity > hs.at + 1000;
      if (stale || supersededByJsonl) {
        this.hookStatus.delete(a.sessionId); // forget it; rely on the heuristic
        continue;
      }
      a.status = hs.status;
      a.statusSource = "hook";
    }

    // Carry the live hook-driven "now doing X" phrase across rediscovery
    // (discovery rebuilds the AgentSession objects from disk each time).
    for (const a of found) {
      const la = this.liveAction.get(a.sessionId);
      if (la && Date.now() - la.at <= LIVE_ACTION_TTL_MS) a.liveAction = la.action;
    }

    // Prune map entries for sessions that have aged out of discovery so the
    // hookStatus / liveAction maps don't grow unbounded over the host lifetime.
    for (const [id, hs] of this.hookStatus) {
      if (!liveIds.has(id) && Date.now() - hs.at > HOOK_STATUS_TTL_MS) this.hookStatus.delete(id);
    }
    for (const [id, la] of this.liveAction) {
      if (!liveIds.has(id) || Date.now() - la.at > LIVE_ACTION_TTL_MS) this.liveAction.delete(id);
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

  /**
   * Update the live "now doing X" phrase for a session (from a hook tool event).
   * Pass `undefined` to clear it (e.g. on Stop). Only fires a change when the
   * phrase actually changes, so a burst of tool events doesn't storm the UI.
   */
  applyLiveAction(sessionId: string, action: string | undefined): void {
    const prev = this.liveAction.get(sessionId)?.action;
    if (action) {
      this.liveAction.set(sessionId, { action, at: Date.now() });
    } else {
      this.liveAction.delete(sessionId);
    }
    if ((prev || undefined) === (action || undefined)) return; // no visible change
    const a = this.agents.find((x) => x.sessionId === sessionId);
    if (a) {
      a.liveAction = action;
      this._onDidChange.fire();
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
