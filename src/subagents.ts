import * as fs from "fs";
import * as path from "path";
import { AgentSession, emptyTokens } from "./types";
import { parseTranscript } from "./transcript";
import { sessionSidecarDir } from "./paths";

/** Recursively collect `agent-*.jsonl` files under a directory. */
function walkAgentFiles(dir: string, out: string[], depth = 0): void {
  if (depth > 6) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      walkAgentFiles(full, out, depth + 1);
    } else if (e.isFile() && /^agent-.*\.jsonl$/.test(e.name)) {
      out.push(full);
    }
  }
}

/** Read an optional `<file>.meta.json` sidecar for agent type / label. */
function readMeta(jsonlPath: string): { agentType?: string; label?: string } {
  const metaPath = jsonlPath.replace(/\.jsonl$/, ".meta.json");
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    return { agentType: meta.agentType || meta.type, label: meta.label || meta.name };
  } catch {
    return {};
  }
}

/**
 * Discover the subagents spawned within a session, by scanning
 * `<projectDir>/<sessionId>/subagents/**` for `agent-*.jsonl` files.
 */
export function findSubagents(
  projectAbsDir: string,
  projectDirName: string,
  sessionId: string,
): AgentSession[] {
  const subRoot = path.join(sessionSidecarDir(projectAbsDir, sessionId), "subagents");
  const files: string[] = [];
  walkAgentFiles(subRoot, files);

  const result: AgentSession[] = [];
  for (const jsonlPath of files) {
    const summary = parseTranscript(jsonlPath);
    const m = /agent-([^/.]+)\.jsonl$/.exec(jsonlPath);
    const agentId = m ? m[1] : path.basename(jsonlPath);
    const meta = readMeta(jsonlPath);

    result.push({
      sessionId: agentId,
      projectDir: projectDirName,
      cwd: summary?.cwd || "",
      jsonlPath,
      label: meta.label || summary?.label || agentId,
      status: summary?.status || "unknown",
      model: summary?.model,
      gitBranch: summary?.gitBranch,
      tokens: summary?.tokens || emptyTokens(),
      lastActivity: summary?.lastActivity || 0,
      messageCount: summary?.messageCount || 0,
      lastAction: summary?.lastAction,
      filesTouched: summary?.filesTouched,
      managed: false,
      kind: "subagent",
      parentId: sessionId,
      agentType: meta.agentType,
      statusSource: "jsonl",
    });
  }

  result.sort((a, b) => b.lastActivity - a.lastActivity);
  return result;
}
