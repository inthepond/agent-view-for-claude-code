import * as fs from "fs";
import * as path from "path";
import { AgentStore } from "../store";
import { AgentSession } from "../types";
import { claudeHome } from "../paths";
import { TeamMember, TeamTask, TeamTaskStatus, TeamWorkflowRun, Team, TeamSnapshot } from "../board/types";

interface TeammateMeta {
  agentId: string;
  name: string;
  spawnMode?: string;
  agentType?: string;
  description?: string;
}

/** The directory holding a session's subagents/ + workflows/. */
function sidecarSubagentsDir(s: AgentSession): string {
  return path.join(path.dirname(s.jsonlPath), s.sessionId, "subagents");
}

/**
 * Named teammates of a session: the TOP-LEVEL `subagents/agent-*.meta.json`
 * sidecars that carry a `name` (Agent Teams marks teammates with a name +
 * spawnMode; plain Task subagents have neither). We do NOT recurse into
 * `subagents/workflows/` — those are workflow fan-out agents, not teammates.
 */
function readTeammates(subDir: string): TeammateMeta[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(subDir);
  } catch {
    return [];
  }
  const out: TeammateMeta[] = [];
  for (const e of entries) {
    if (!e.endsWith(".meta.json")) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(subDir, e), "utf8"));
      if (!meta || typeof meta.name !== "string" || !meta.name) continue;
      const m = /^agent-([^.]+)\.meta\.json$/.exec(e);
      out.push({
        agentId: m ? m[1] : e,
        name: meta.name,
        spawnMode: typeof meta.spawnMode === "string" ? meta.spawnMode : undefined,
        agentType: meta.agentType || meta.type,
        description: meta.description,
      });
    } catch {
      /* skip a malformed sidecar */
    }
  }
  return out;
}

const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;

/** The most recent TodoWrite `todos` array recorded in a transcript. */
function latestTodos(jsonlPath: string): any[] | undefined {
  let raw: string;
  try {
    const stat = fs.statSync(jsonlPath);
    if (stat.size > MAX_TRANSCRIPT_BYTES) {
      const fd = fs.openSync(jsonlPath, "r");
      try {
        const buf = Buffer.alloc(MAX_TRANSCRIPT_BYTES);
        const n = fs.readSync(fd, buf, 0, MAX_TRANSCRIPT_BYTES, stat.size - MAX_TRANSCRIPT_BYTES);
        raw = buf.toString("utf8", 0, n);
      } finally {
        fs.closeSync(fd);
      }
    } else {
      raw = fs.readFileSync(jsonlPath, "utf8");
    }
  } catch {
    return undefined;
  }
  let todos: any[] | undefined;
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o?.isSidechain === true) continue; // the lead's own list, not a teammate's
    const content = o?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b?.type === "tool_use" && b.name === "TodoWrite" && Array.isArray(b.input?.todos)) {
        todos = b.input.todos;
      }
    }
  }
  return todos;
}

/** Parse the TodoWrite list into tasks, extracting owner + dependency edges from
 *  the conventional "owner: X" / "DEPENDS ON N" hints the lead writes. */
function parseTasks(todos: any[]): TeamTask[] {
  return todos.map((t, i): TeamTask => {
    const raw = String((t && (t.content ?? t.activeForm)) ?? "").trim();
    const status: TeamTaskStatus =
      t?.status === "in_progress" ? "in_progress" : t?.status === "completed" ? "completed" : "pending";
    const ownerMatch = raw.match(/owner:\s*([^\s,(){}]+)/i);
    const dependsOn = new Set<string>();
    // "DEPENDS ON" is a deliberate uppercase sentinel, so lowercase prose
    // ("depends on 3 libraries") never registers. Only the leading number list
    // right after it counts — bounded so trailing-prose digits aren't harvested.
    const depMatch = raw.match(/DEPENDS ON\b([^.;)\n]*)/);
    if (depMatch) {
      const list = depMatch[1].match(/^[\s:]*(?:tasks?\s*)?((?:#?\d+(?:\s*(?:,|and|&)\s*)?)+)/i);
      for (const n of (list ? list[1].match(/\d+/g) : null) || []) {
        const idx = parseInt(n, 10);
        if (idx >= 1 && idx <= todos.length && idx !== i + 1) dependsOn.add(`t${idx}`);
      }
    }
    // Drop the parsed hint clusters from the display label (owner shows as a
    // badge, dependencies as edges); bounded so real wording is never swallowed.
    const content =
      raw
        .replace(/[\s—-]*[([]?\s*owner:\s*[^\s,(){}\]]+\s*[)\]]?/gi, "")
        .replace(/[\s—-]*[([]?\s*DEPENDS ON\b\s*(?:tasks?\s*)?(?:#?\d+(?:\s*(?:,|and|&)\s*)?)*[)\]]?/g, "")
        .replace(/\s{2,}/g, " ")
        .trim() || raw;
    return {
      id: `t${i + 1}`,
      content,
      status,
      owner: ownerMatch ? ownerMatch[1] : undefined,
      dependsOn: [...dependsOn],
    };
  });
}

function readWorkflowRuns(subDir: string): TeamWorkflowRun[] {
  const wfDir = path.join(subDir, "workflows");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(wfDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const runs: TeamWorkflowRun[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.startsWith("wf_")) continue;
    let count = 0;
    try {
      count = fs.readdirSync(path.join(wfDir, e.name)).filter((f) => /^agent-.*\.jsonl$/.test(f)).length;
    } catch {
      /* ignore */
    }
    runs.push({ id: e.name, agentCount: count });
  }
  return runs;
}

/** ~/.claude/teams or ~/.claude/tasks present — the native Agent Teams store.
 *  We only flag it (the on-disk task schema is undocumented and does not
 *  materialize in this environment); reading it is left for when it appears. */
function nativeStoreDetected(): boolean {
  return (
    fs.existsSync(path.join(claudeHome(), "teams")) || fs.existsSync(path.join(claudeHome(), "tasks"))
  );
}

function tokensOf(a: AgentSession | undefined): number {
  if (!a) return 0;
  const t = a.tokens;
  return t.input + t.output + t.cacheRead + t.cacheCreate;
}

/** Bound on the number of teams built per snapshot (each reads a transcript). */
const MAX_TEAMS = 8;

/** Roster of named teammates, enriched with the store's live status/tokens. */
function buildMembers(s: AgentSession, roster: TeammateMeta[]): TeamMember[] {
  const subs = s.subagents || [];
  return roster
    .map((meta): TeamMember => {
      const live = subs.find((x) => x.sessionId === meta.agentId);
      return {
        sessionId: meta.agentId,
        name: meta.name,
        agentType: meta.agentType,
        spawnMode: meta.spawnMode,
        status: live?.status || "unknown",
        tokensTotal: tokensOf(live),
        lastAction: live?.liveAction || live?.lastAction,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Build a live snapshot of EVERY active team — each session that has named
 * teammates becomes a Team (roster + the shared task graph parsed from its
 * TodoWrite list), most-recently-active first, so the cockpit can switch
 * between them. Capped at MAX_TEAMS transcript reads.
 */
export function buildTeamSnapshot(store: AgentStore): TeamSnapshot {
  const native = nativeStoreDetected();
  const sessions = store
    .list()
    .filter((a) => a.kind === "session")
    .sort((a, b) => b.lastActivity - a.lastActivity);

  const teams: Team[] = [];
  for (const s of sessions) {
    if (teams.length >= MAX_TEAMS) break;
    const roster = readTeammates(sidecarSubagentsDir(s));
    if (roster.length === 0) continue;
    const todos = latestTodos(s.jsonlPath);
    teams.push({
      leadSessionId: s.sessionId,
      leadLabel: s.label,
      members: buildMembers(s, roster),
      tasks: todos ? parseTasks(todos) : [],
      workflowRuns: readWorkflowRuns(sidecarSubagentsDir(s)),
    });
  }

  return {
    present: teams.length > 0,
    source: teams.length > 0 ? "todowrite" : "none",
    teams,
    nativeStoreDetected: native,
  };
}
