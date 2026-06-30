import * as vscode from "vscode";
import * as path from "path";
import { changedFiles, showFileAtRef } from "../orchestrator/worktree";

/** Virtual scheme serving a file's contents at the agent's fork-point commit,
 *  so the review can show a real side-by-side diff (base vs the live worktree
 *  file) instead of a flat text dump. */
export const BASE_SCHEME = "agentview-base";

export interface DiffTarget {
  worktreePath: string;
  baseRef: string;
  label: string;
}

/** Resolves a session id to its worktree + fork point (or undefined). */
export type DiffResolver = (sessionId: string) => DiffTarget | undefined;

export class BaseContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly resolve: DiffResolver) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const q = new URLSearchParams(uri.query);
    if (q.get("empty") === "1") return "";
    const sid = q.get("sid") || "";
    const file = q.get("file") || "";
    const t = this.resolve(sid);
    if (!t || !file) return "";
    try {
      return await showFileAtRef(t.worktreePath, t.baseRef, file);
    } catch {
      return "";
    }
  }
}

function baseUri(sessionId: string, file: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: BASE_SCHEME,
    path: "/" + file,
    query: `sid=${encodeURIComponent(sessionId)}&file=${encodeURIComponent(file)}`,
  });
}

function emptyUri(file: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: BASE_SCHEME,
    path: "/" + file,
    query: `empty=1&file=${encodeURIComponent(file)}`,
  });
}

/**
 * Open each changed file as a native VS Code side-by-side diff (base on the
 * left, the live worktree file on the right). Returns the TOTAL number of
 * changed files (which may exceed `maxFiles`, so the caller can warn).
 */
export async function openReviewDiff(
  sessionId: string,
  target: DiffTarget,
  maxFiles: number,
): Promise<number> {
  const files = await changedFiles(target.worktreePath, target.baseRef);
  for (const f of files.slice(0, Math.max(1, maxFiles))) {
    const left = f.status === "A" ? emptyUri(f.path) : baseUri(sessionId, f.path);
    const right =
      f.status === "D"
        ? emptyUri(f.path)
        : vscode.Uri.file(path.join(target.worktreePath, f.path));
    const tag = f.status === "A" ? "new" : f.status === "D" ? "deleted" : "changed";
    const title = `${path.basename(f.path)} · ${tag} · ${target.label}`;
    await vscode.commands.executeCommand("vscode.diff", left, right, title, { preview: false });
  }
  return files.length;
}
