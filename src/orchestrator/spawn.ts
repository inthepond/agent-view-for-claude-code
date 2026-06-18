import * as vscode from "vscode";
import { randomUUID } from "crypto";
import { Registry } from "./registry";
import { terminals } from "./terminals";
import { isGitRepo, repoRoot, createWorktree } from "./worktree";

export interface SpawnConfig {
  claudePath: string;
  defaultModel: string;
  worktreeRoot: string;
  spawnExtraFlags: string[];
}

export interface SpawnRequest {
  cwd: string;
  task?: string;
  model?: string;
  useWorktree: boolean;
  branch?: string;
}

export interface SpawnResult {
  sessionId: string;
  worktreePath: string;
  branch: string;
}

/** POSIX single-quote escape for safe interpolation into a shell command. */
function shquote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function buildCommand(cfg: SpawnConfig, sessionId: string, model: string, task?: string): string {
  const parts = [cfg.claudePath, "--session-id", sessionId];
  if (model) parts.push("--model", model);
  for (const f of cfg.spawnExtraFlags) parts.push(f);
  if (task && task.trim()) parts.push(shquote(task.trim()));
  return parts.join(" ");
}

/**
 * Spawn a new Claude Code agent. When `useWorktree` is set and the cwd is a git
 * repo, the agent runs in a fresh worktree + branch. The session id is
 * pre-generated and passed via `--session-id` so the agent maps deterministically
 * to its `<uuid>.jsonl` transcript.
 */
export async function spawnAgent(
  req: SpawnRequest,
  registry: Registry,
  cfg: SpawnConfig,
): Promise<SpawnResult> {
  const sessionId = randomUUID();
  const branch = req.branch || `mas/${sessionId.slice(0, 8)}`;
  const model = req.model || cfg.defaultModel;

  let workdir = req.cwd;
  let worktreePath = req.cwd;
  let root = req.cwd;

  if (req.useWorktree && (await isGitRepo(req.cwd))) {
    root = await repoRoot(req.cwd);
    const wt = await createWorktree(root, branch, cfg.worktreeRoot);
    workdir = wt.worktreePath;
    worktreePath = wt.worktreePath;
  }

  const terminal = vscode.window.createTerminal({ name: `Claude Code ${branch}`, cwd: workdir });
  terminal.show(true);
  terminal.sendText(buildCommand(cfg, sessionId, model, req.task));
  terminals.register(sessionId, terminal);

  await registry.add({
    sessionId,
    branch,
    worktreePath,
    repoRoot: root,
    cwd: workdir,
    label: req.task?.replace(/\s+/g, " ").slice(0, 80) || branch,
    model: model || undefined,
    createdAt: Date.now(),
  });

  return { sessionId, worktreePath, branch };
}
