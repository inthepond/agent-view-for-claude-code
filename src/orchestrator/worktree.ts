import { execFile } from "child_process";
import * as path from "path";
import * as fs from "fs";

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr?.toString().trim() || err.message));
      else resolve(stdout.toString().trim());
    });
  });
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    const out = await git(["rev-parse", "--is-inside-work-tree"], cwd);
    return out === "true";
  } catch {
    return false;
  }
}

export async function repoRoot(cwd: string): Promise<string> {
  return git(["rev-parse", "--show-toplevel"], cwd);
}

/** Current branch (or short SHA when detached), used as the worktree base. */
export async function currentRef(cwd: string): Promise<string> {
  try {
    const b = await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
    if (b && b !== "HEAD") return b;
  } catch {
    /* fall through */
  }
  return git(["rev-parse", "--short", "HEAD"], cwd);
}

export interface WorktreeResult {
  worktreePath: string;
  branch: string;
  /** The exact commit the worktree forked from — the stable diff/merge base. */
  baseRef: string;
}

/**
 * Create an isolated worktree + branch off the repo's current ref.
 * Worktrees live under `<repoRoot>/<worktreeRoot>/<branch-leaf>`.
 *
 * The fork-point commit is captured and returned as `baseRef` so later diffs
 * stay correct even if the user switches the repo's branch afterwards.
 */
export async function createWorktree(
  root: string,
  branch: string,
  worktreeRoot: string,
): Promise<WorktreeResult> {
  const leaf = branch.replace(/[^a-zA-Z0-9._-]/g, "-");
  const wtPath = path.join(root, worktreeRoot, leaf);
  fs.mkdirSync(path.dirname(wtPath), { recursive: true });

  const baseRef = await git(["rev-parse", "HEAD"], root);

  // If the branch already exists, attach to it; otherwise create it off the
  // captured base commit (so concurrent spawns can't shift the fork point).
  let branchExists = false;
  try {
    await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], root);
    branchExists = true;
  } catch {
    branchExists = false;
  }

  const args = branchExists
    ? ["worktree", "add", wtPath, branch]
    : ["worktree", "add", "-b", branch, wtPath, baseRef];
  await git(args, root);

  return { worktreePath: wtPath, branch, baseRef };
}

export async function removeWorktree(root: string, worktreePath: string): Promise<void> {
  await git(["worktree", "remove", "--force", worktreePath], root);
}

/** Diff of the worktree against its merge-base with the base ref. */
export async function worktreeDiff(worktreePath: string, baseRef: string): Promise<string> {
  return git(["diff", `${baseRef}...HEAD`], worktreePath).catch(() =>
    git(["diff", "HEAD"], worktreePath),
  );
}

/** The worktree's current HEAD commit (used to stamp a pinned diff). */
export async function headCommit(cwd: string): Promise<string> {
  return git(["rev-parse", "HEAD"], cwd).catch(() => "");
}
