import * as vscode from "vscode";
import * as path from "path";
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
  /** Race/fan-out group id — agents spawned together share one. */
  groupId?: string;
  /** Role within the group: competitive "race" or independent "fanout" batch. */
  groupRole?: "race" | "fanout";
  /** Optional human label override (fan-out uses the task text). */
  label?: string;
}

export interface SpawnResult {
  sessionId: string;
  worktreePath: string;
  branch: string;
}

/**
 * Quote a string as a single shell argument. The terminal uses the OS default
 * shell, so quoting must match: POSIX single-quote on macOS/Linux, PowerShell
 * single-quote (doubled `''`) on Windows where the default integrated shell is
 * PowerShell.
 */
function shquote(s: string): string {
  if (process.platform === "win32") {
    return `'${s.replace(/'/g, "''")}'`;
  }
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function buildCommand(cfg: SpawnConfig, sessionId: string, model: string, task?: string): string {
  const parts = [cfg.claudePath, "--session-id", sessionId];
  if (model) parts.push("--model", model);
  // Quote each extra flag as one argument — entries are untrusted (overridable
  // at workspace scope) and may contain spaces/metacharacters.
  for (const f of cfg.spawnExtraFlags) parts.push(shquote(f));
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
  let baseRef: string | undefined;

  if (req.useWorktree && (await isGitRepo(req.cwd))) {
    root = await repoRoot(req.cwd);
    const wt = await createWorktree(root, branch, cfg.worktreeRoot);
    workdir = wt.worktreePath;
    worktreePath = wt.worktreePath;
    baseRef = wt.baseRef;
  }

  // Point the agent at the repo-root Pinboard so it can read the user's
  // selection and post result cards (worktree agents can't derive it from cwd).
  const boardDir = path.join(root, ".agentview", "board");
  const terminal = vscode.window.createTerminal({
    name: `Claude Code ${branch}`,
    cwd: workdir,
    env: { AGENTVIEW_BOARD_DIR: boardDir },
  });
  terminal.show(true);
  terminal.sendText(buildCommand(cfg, sessionId, model, req.task));
  terminals.register(sessionId, terminal);

  await registry.add({
    sessionId,
    branch,
    worktreePath,
    repoRoot: root,
    cwd: workdir,
    label: req.label || req.task?.replace(/\s+/g, " ").slice(0, 80) || branch,
    model: model || undefined,
    createdAt: Date.now(),
    baseRef,
    groupId: req.groupId,
    groupRole: req.groupRole,
    task: req.task,
  });

  return { sessionId, worktreePath, branch };
}
