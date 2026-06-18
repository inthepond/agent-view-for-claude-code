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
