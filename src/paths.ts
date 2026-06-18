import * as os from "os";
import * as path from "path";

/**
 * Root of the Claude Code config directory. Honors CLAUDE_CONFIG_DIR, which
 * Claude Code uses to relocate ~/.claude.
 */
export function claudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

export function projectsDir(): string {
  return path.join(claudeHome(), "projects");
}

export function settingsPath(): string {
  return path.join(claudeHome(), "settings.json");
}

/**
 * Claude Code encodes a cwd into a project dir name by replacing path
 * separators and dots with "-" (e.g. /Users/x/Desktop/MAS ->
 * -Users-x-Desktop-MAS). This is NOT reliably reversible (real "-" and "."
 * collide), so we only use it to *locate* a project dir; the true cwd is read
 * back out of the transcript's own `cwd` field.
 */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

/** Directory holding a session's sidecar files (subagents/, memory/, …). */
export function sessionSidecarDir(projectAbsDir: string, sessionId: string): string {
  return path.join(projectAbsDir, sessionId);
}
