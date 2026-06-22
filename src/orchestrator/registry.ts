import * as vscode from "vscode";

export interface ManagedAgent {
  sessionId: string;
  branch: string;
  worktreePath: string;
  /** The repo root the worktree was created from. */
  repoRoot: string;
  cwd: string;
  label: string;
  model?: string;
  createdAt: number;
  /** Commit the worktree forked from — stable diff/merge base. */
  baseRef?: string;
  /** Race/fan-out group id — agents spawned together share one. */
  groupId?: string;
  /** Role within the group: competitive "race" or independent "fanout" batch. */
  groupRole?: "race" | "fanout";
  /** The task prompt this agent was spawned with. */
  task?: string;
}

const KEY = "mas.managedAgents";

/** Persists the agents MAS has spawned (so we can label/diff/stop them). */
export class Registry {
  constructor(private state: vscode.Memento) {}

  all(): ManagedAgent[] {
    return this.state.get<ManagedAgent[]>(KEY, []);
  }

  get(sessionId: string): ManagedAgent | undefined {
    return this.all().find((a) => a.sessionId === sessionId);
  }

  /** All managed agents spawned as part of one race/fan-out group. */
  byGroup(groupId: string): ManagedAgent[] {
    return this.all().filter((a) => a.groupId === groupId);
  }

  async add(agent: ManagedAgent): Promise<void> {
    const next = this.all().filter((a) => a.sessionId !== agent.sessionId);
    next.push(agent);
    await this.state.update(KEY, next);
  }

  async remove(sessionId: string): Promise<void> {
    await this.state.update(
      KEY,
      this.all().filter((a) => a.sessionId !== sessionId),
    );
  }
}
