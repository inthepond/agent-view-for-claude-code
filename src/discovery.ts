import * as fs from "fs";
import * as path from "path";
import { AgentSession, emptyTokens } from "./types";
import { parseTranscript } from "./transcript";
import { findSubagents } from "./subagents";
import { projectsDir } from "./paths";

export interface ManagedInfo {
  worktreePath?: string;
  label?: string;
  groupId?: string;
  groupRole?: "race" | "fanout";
}

export interface DiscoverOptions {
  recentDays: number;
  /** Returns managed metadata if MAS spawned this session, else undefined. */
  managedLookup?: (sessionId: string) => ManagedInfo | undefined;
}

function listSessionFiles(projectAbsDir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(projectAbsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
    .map((e) => path.join(projectAbsDir, e.name));
}

/**
 * Scan ~/.claude/projects for recent Claude Code sessions and build the agent
 * fleet. Each top-level `<session-id>.jsonl` is a session; nested
 * `<session-id>/subagents/**` files become its subagents.
 */
export function discoverAgents(opts: DiscoverOptions): AgentSession[] {
  const root = projectsDir();
  const cutoff = Date.now() - opts.recentDays * 24 * 60 * 60 * 1000;

  let projectDirs: fs.Dirent[];
  try {
    projectDirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const sessions: AgentSession[] = [];

  for (const pd of projectDirs) {
    if (!pd.isDirectory()) continue;
    const projectAbsDir = path.join(root, pd.name);

    for (const jsonlPath of listSessionFiles(projectAbsDir)) {
      let mtime = 0;
      try {
        mtime = fs.statSync(jsonlPath).mtimeMs;
      } catch {
        continue;
      }
      if (mtime < cutoff) continue;

      const sessionId = path.basename(jsonlPath, ".jsonl");
      const summary = parseTranscript(jsonlPath);
      if (!summary) continue;

      const managed = opts.managedLookup?.(sessionId);

      const session: AgentSession = {
        sessionId,
        projectDir: pd.name,
        cwd: summary.cwd || "",
        jsonlPath,
        label: managed?.label || summary.label,
        status: summary.status,
        model: summary.model,
        gitBranch: summary.gitBranch,
        tokens: summary.tokens || emptyTokens(),
        lastActivity: summary.lastActivity || mtime,
        messageCount: summary.messageCount,
        lastAction: summary.lastAction,
        filesTouched: summary.filesTouched,
        managed: !!managed,
        worktreePath: managed?.worktreePath,
        groupId: managed?.groupId,
        groupRole: managed?.groupRole,
        kind: "session",
        statusSource: "jsonl",
        subagents: findSubagents(projectAbsDir, pd.name, sessionId),
      };

      sessions.push(session);
    }
  }

  sessions.sort((a, b) => b.lastActivity - a.lastActivity);
  return sessions;
}
