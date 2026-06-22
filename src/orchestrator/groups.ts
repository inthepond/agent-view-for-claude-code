import * as vscode from "vscode";
import { randomUUID } from "crypto";
import { Registry } from "./registry";
import { spawnAgent, SpawnConfig, SpawnResult } from "./spawn";
import { removeWorktree } from "./worktree";
import { terminals } from "./terminals";
import { AgentStore } from "../store";

/** Short, unique id shared by every agent spawned in one race / fan-out. */
export function newGroupId(): string {
  return "g" + randomUUID().slice(0, 8);
}

/**
 * Agent Race — spawn N agents on the SAME prompt, each in its own worktree, all
 * tagged with one group id. The caller compares their diffs and picks a winner;
 * nothing is merged or deleted automatically.
 */
export async function spawnRace(
  opts: { cwd: string; task: string; count: number; model?: string },
  registry: Registry,
  cfg: SpawnConfig,
): Promise<{ groupId: string; results: SpawnResult[] }> {
  const groupId = newGroupId();
  const results: SpawnResult[] = [];
  for (let i = 0; i < opts.count; i++) {
    const res = await spawnAgent(
      {
        cwd: opts.cwd,
        task: opts.task,
        model: opts.model,
        useWorktree: true,
        branch: `mas/${groupId}-${i}`,
        groupId,
        groupRole: "race",
        label: `Race ${i + 1} · ${opts.task}`,
      },
      registry,
      cfg,
    );
    results.push(res);
  }
  return { groupId, results };
}

export interface BatchTask {
  task: string;
  model?: string;
}

/** A started agent hasn't been observed running within this window — give up
 *  waiting on it and free its slot so the queue can't stall forever. */
const STARTUP_GRACE_MS = 90_000;

/**
 * Fan-out — spawn one worktree agent per task, but keep at most
 * `maxConcurrent` running at once. As earlier agents go idle/done, queued
 * tasks start. Completion is read from the store's status, so it works best
 * with hooks installed (and degrades to the transcript heuristic without).
 */
export class FanoutBatch {
  readonly groupId = newGroupId();
  private readonly pending: BatchTask[];
  private readonly startedAt = new Map<string, number>();
  private readonly seenActive = new Set<string>();
  private sub?: vscode.Disposable;
  private finished = false;
  private spawning = false;

  constructor(
    private readonly opts: {
      cwd: string;
      tasks: BatchTask[];
      useWorktree: boolean;
      maxConcurrent: number;
    },
    private readonly registry: Registry,
    private readonly cfg: SpawnConfig,
    private readonly store: AgentStore,
    private readonly onProgress?: (info: { started: number; total: number; done: boolean }) => void,
  ) {
    this.pending = [...opts.tasks];
  }

  get total(): number {
    return this.opts.tasks.length;
  }

  /** Begin spawning. Resolves once the first wave is launched; the rest drain
   *  in the background as slots free up. */
  async start(): Promise<void> {
    await this.fill();
    if (this.pending.length > 0 && !this.finished) {
      this.sub = this.store.onDidChange(() => {
        void this.fill();
      });
    } else {
      this.complete();
    }
  }

  dispose(): void {
    this.complete();
  }

  private complete(): void {
    if (this.finished) return;
    this.finished = true;
    this.sub?.dispose();
    this.sub = undefined;
    this.onProgress?.({ started: this.startedCount(), total: this.total, done: true });
  }

  private startedCount(): number {
    return this.startedAt.size;
  }

  /** Count agents we've launched that haven't settled (idle/done/error after
   *  having been seen active, or that blew past the startup grace). */
  private inFlight(): number {
    let n = 0;
    for (const id of this.startedAt.keys()) {
      const a = this.store.getById(id);
      const active = a?.status === "running" || a?.status === "waiting";
      if (active) {
        this.seenActive.add(id);
        n++;
        continue;
      }
      const settled =
        (this.seenActive.has(id) && !!a) || // ran, now resting
        Date.now() - (this.startedAt.get(id) || 0) > STARTUP_GRACE_MS; // never appeared
      if (!settled) n++;
    }
    return n;
  }

  private async fill(): Promise<void> {
    if (this.finished || this.spawning) return;
    this.spawning = true;
    try {
      while (this.pending.length > 0 && this.inFlight() < this.opts.maxConcurrent) {
        const next = this.pending.shift()!;
        try {
          const res = await spawnAgent(
            {
              cwd: this.opts.cwd,
              task: next.task,
              model: next.model,
              useWorktree: this.opts.useWorktree,
              branch: `mas/${this.groupId}-${this.startedAt.size}`,
              groupId: this.groupId,
              groupRole: "fanout",
              label: next.task,
            },
            this.registry,
            this.cfg,
          );
          this.startedAt.set(res.sessionId, Date.now());
        } catch {
          // a failed spawn shouldn't wedge the queue — drop the task and move on
        }
        this.onProgress?.({ started: this.startedCount(), total: this.total, done: false });
      }
    } finally {
      this.spawning = false;
    }
    if (this.pending.length === 0) this.complete();
  }
}

/**
 * Remove the worktrees of a race / fan-out group. Branches are kept (so
 * committed work is never lost); only the worktree checkouts and the managed
 * registry entries are cleared. Pass `keepSessionId` to spare the winner.
 */
export async function cleanupGroup(
  groupId: string,
  registry: Registry,
  opts: { keepSessionId?: string } = {},
): Promise<{ removed: number; errors: string[] }> {
  const errors: string[] = [];
  let removed = 0;
  for (const m of registry.byGroup(groupId)) {
    if (opts.keepSessionId && m.sessionId === opts.keepSessionId) continue;
    try {
      terminals.stop(m.sessionId, `Claude Code ${m.branch}`.trim());
    } catch {
      /* terminal already gone */
    }
    try {
      if (m.worktreePath && m.repoRoot) {
        await removeWorktree(m.repoRoot, m.worktreePath);
        removed++;
      }
      // Only forget the agent once its worktree is actually gone — a failed
      // removal stays registered so it remains visible and retriable.
      await registry.remove(m.sessionId);
    } catch (e: any) {
      errors.push(`${m.branch}: ${e.message}`);
    }
  }
  return { removed, errors };
}
