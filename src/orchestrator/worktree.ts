import { execFile } from "child_process";
import { createHash } from "crypto";
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

// ---------------------------------------------------------------------------
// Review & Land — truthful diffs (incl. uncommitted/untracked) + merge plumbing
// ---------------------------------------------------------------------------

/** Tolerant git: resolves with the exit code instead of throwing. `git diff
 *  --no-index` and similar return a non-zero code merely to signal "differs", so
 *  the throwing `git()` helper can't be used for them. */
function gitTry(
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err: any, stdout, stderr) => {
      resolve({
        code: typeof err?.code === "number" ? err.code : err ? 1 : 0,
        stdout: stdout?.toString() ?? "",
        stderr: stderr?.toString() ?? "",
      });
    });
  });
}

const NULL_DEVICE = "/dev/null"; // git accepts this in --no-index on all platforms

export interface ChangedFile {
  path: string;
  /** Added (incl. untracked), Modified, or Deleted vs the base. */
  status: "A" | "M" | "D";
}

export interface DiffStat {
  files: number;
  additions: number;
  deletions: number;
}

/** Untracked, non-ignored files in the worktree. */
async function untrackedFiles(worktreePath: string): Promise<string[]> {
  const r = await gitTry(["ls-files", "--others", "--exclude-standard"], worktreePath);
  return r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

/** Files changed in the worktree vs the base (tracked diff + untracked as adds). */
export async function changedFiles(worktreePath: string, base: string): Promise<ChangedFile[]> {
  const out: ChangedFile[] = [];
  // --no-renames so a rename decomposes into D(old)+A(new): the old-path
  // deletion must be reviewed (and lands at squash time), and openReviewDiff
  // already renders A/D correctly — whereas a grouped rename would hide the
  // deletion and mis-render the new path as a base-less "changed" file.
  const r = await gitTry(["diff", base, "--name-status", "-z", "--no-renames"], worktreePath);
  // -z output: <status>\0<path>\0[<path2>\0 for renames] ...
  const parts = r.stdout.split("\0").filter((s) => s.length > 0);
  for (let i = 0; i < parts.length; ) {
    const code = parts[i];
    const letter = code[0];
    if (letter === "R" || letter === "C") {
      // rename/copy: status, oldPath, newPath
      const newPath = parts[i + 2];
      if (newPath) out.push({ path: newPath, status: "M" });
      i += 3;
    } else {
      const p = parts[i + 1];
      if (p) {
        const status = letter === "A" ? "A" : letter === "D" ? "D" : "M";
        out.push({ path: p, status });
      }
      i += 2;
    }
  }
  for (const f of await untrackedFiles(worktreePath)) out.push({ path: f, status: "A" });
  return out;
}

/** +adds / -dels / file count for the review row (tracked numstat + untracked). */
export async function reviewDiffStat(worktreePath: string, base: string): Promise<DiffStat> {
  let files = 0;
  let additions = 0;
  let deletions = 0;
  const numstat = (await gitTry(["diff", base, "--numstat", "--no-renames"], worktreePath)).stdout;
  for (const line of numstat.split("\n")) {
    const m = line.match(/^(\d+|-)\t(\d+|-)\t/);
    if (!m) continue;
    files++;
    if (m[1] !== "-") additions += parseInt(m[1], 10);
    if (m[2] !== "-") deletions += parseInt(m[2], 10);
  }
  // Let git count untracked-file additions (matches its own line counting and
  // reports "-" for binary, so no off-by-one and no bogus count for binaries).
  for (const f of await untrackedFiles(worktreePath)) {
    files++;
    const r = await gitTry(["diff", "--no-index", "--numstat", "--", NULL_DEVICE, f], worktreePath);
    const m = r.stdout.match(/^(\d+|-)\t/);
    if (m && m[1] !== "-") additions += parseInt(m[1], 10);
  }
  return { files, additions, deletions };
}

/** Contents of a file at a ref (empty string if it didn't exist there, or if
 *  the ref is unknown — never fall back to the index/`:file` form). */
export async function showFileAtRef(
  worktreePath: string,
  ref: string,
  file: string,
): Promise<string> {
  if (!ref) return "";
  const r = await gitTry(["show", `${ref}:${file}`], worktreePath);
  return r.code === 0 ? r.stdout : "";
}

/** True when the working tree has no uncommitted changes (clean to merge into). */
export async function isWorkingTreeClean(dir: string): Promise<boolean> {
  const r = await gitTry(["status", "--porcelain"], dir);
  return r.code === 0 && r.stdout.trim() === "";
}

export async function hasUncommittedChanges(dir: string): Promise<boolean> {
  return !(await isWorkingTreeClean(dir));
}

/** Content fingerprint of the worktree's uncommitted state (file statuses +
 *  unstaged/staged content). "" = clean or unreadable. Lets callers tell
 *  "still dirty with the SAME content" apart from "dirty with NEW content"
 *  without committing anything — Evidence Gates uses this for staleness. */
export async function uncommittedDigest(dir: string): Promise<string> {
  const status = await gitTry(["status", "--porcelain"], dir);
  if (status.code !== 0 || status.stdout.trim() === "") return "";
  const diff = await gitTry(["diff", "HEAD"], dir);
  return createHash("sha256").update(status.stdout).update(diff.stdout).digest("hex");
}

/** True when `dir` is mid-merge/rebase (don't touch it). */
export async function isMergeInProgress(dir: string): Promise<boolean> {
  const merge = await gitTry(["rev-parse", "-q", "--verify", "MERGE_HEAD"], dir);
  if (merge.code === 0) return true;
  // a rebase leaves these dirs under .git
  for (const d of ["rebase-merge", "rebase-apply"]) {
    if (fs.existsSync(path.join(dir, ".git", d))) return true;
  }
  return false;
}

/** Stage everything and commit (used to snapshot uncommitted agent work so the
 *  reviewed diff and the landed diff are identical). No-op if nothing to commit. */
export async function commitAll(dir: string, message: string): Promise<boolean> {
  await gitTry(["add", "-A"], dir);
  const r = await gitTry(["commit", "-m", message], dir);
  return r.code === 0;
}

export interface SquashResult {
  ok: boolean;
  /** Merge produced conflicts — the caller should reset to the pre-merge head. */
  conflict: boolean;
  /** The branch had nothing new to land (already merged / empty). */
  noChanges?: boolean;
  message?: string;
}

/**
 * Squash-merge `branch` into the currently checked-out branch of `repoRoot` and
 * commit. The caller MUST have verified the tree is clean and captured a
 * pre-merge head for undo. On conflict, nothing is committed.
 */
export async function squashMergeBranch(repoRoot: string, branch: string): Promise<SquashResult> {
  const merged = await gitTry(["merge", "--squash", branch], repoRoot);
  if (merged.code !== 0) {
    const unmerged = (await gitTry(["ls-files", "-u"], repoRoot)).stdout.trim();
    return {
      ok: false,
      conflict: !!unmerged || /conflict/i.test(merged.stderr),
      message: merged.stderr.trim() || merged.stdout.trim(),
    };
  }
  // A no-op merge (branch already merged / empty) stages nothing — distinguish
  // it from a real failure so the caller can say "nothing to land" rather than
  // surfacing git's "nothing to commit" as an error.
  const staged = await gitTry(["diff", "--cached", "--quiet"], repoRoot);
  if (staged.code === 0) return { ok: true, conflict: false, noChanges: true };
  const committed = await gitTry(["commit", "-m", `Agent View: merge ${branch}`], repoRoot);
  if (committed.code !== 0) {
    return { ok: false, conflict: false, message: committed.stderr.trim() || "commit failed" };
  }
  return { ok: true, conflict: false };
}

export async function resetHard(dir: string, ref: string): Promise<void> {
  await gitTry(["reset", "--hard", ref], dir);
}

/** Pick a remote to push/PR against: `origin` if present, else the first one. */
export async function defaultRemote(repoRoot: string): Promise<string | undefined> {
  const r = await gitTry(["remote"], repoRoot);
  const remotes = r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  if (remotes.includes("origin")) return "origin";
  return remotes[0];
}

export async function pushBranch(repoRoot: string, branch: string, remote: string): Promise<SquashResult> {
  const r = await gitTry(["push", "-u", remote, `${branch}:${branch}`], repoRoot);
  return { ok: r.code === 0, conflict: false, message: r.stderr.trim() || r.stdout.trim() };
}

/** Normalize a remote URL to its https web form (for a compare link). */
export async function remoteWebUrl(repoRoot: string, remote: string): Promise<string | undefined> {
  const r = await gitTry(["remote", "get-url", remote], repoRoot);
  let url = r.stdout.trim();
  if (!url) return undefined;
  // scp form: git@host:owner/repo(.git)
  url = url.replace(/^git@([^:]+):/, "https://$1/");
  // ssh url form: ssh://git@host[:port]/owner/repo(.git) — drop the port, which
  // is not part of the web URL.
  url = url.replace(/^ssh:\/\/(?:git@)?([^/:]+)(?::\d+)?\//, "https://$1/");
  url = url.replace(/\.git$/, "");
  return url.startsWith("http") ? url : undefined;
}
