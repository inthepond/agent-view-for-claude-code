import { useMemo, useState } from "react";
import type { Team, TeamSnapshot, TeamTask, TeamTaskStatus } from "./protocol";
import { Dot, fmtTok } from "../ui";

const NODE_W = 210;
const NODE_H = 84;
const H_GAP = 36;
const V_GAP = 58;

/** Longest-path depth of each task (its dependency layer), cycle-guarded. */
function computeDepths(tasks: TeamTask[]): Map<string, number> {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const calc = (id: string): number => {
    const cached = depth.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0; // dependency cycle — break it
    visiting.add(id);
    const t = byId.get(id);
    let d = 0;
    if (t) for (const dep of t.dependsOn) if (byId.has(dep)) d = Math.max(d, calc(dep) + 1);
    visiting.delete(id);
    depth.set(id, d);
    return d;
  };
  for (const t of tasks) calc(t.id);
  return depth;
}

interface Pt {
  x: number;
  y: number;
}

function useLayout(tasks: TeamTask[]) {
  return useMemo(() => {
    const depth = computeDepths(tasks);
    const layers = new Map<number, TeamTask[]>();
    for (const t of tasks) {
      const d = depth.get(t.id) ?? 0;
      const arr = layers.get(d);
      if (arr) arr.push(t);
      else layers.set(d, [t]);
    }
    const pos = new Map<string, Pt>();
    let maxCols = 0;
    let maxDepth = 0;
    for (const [d, ts] of layers) {
      maxCols = Math.max(maxCols, ts.length);
      maxDepth = Math.max(maxDepth, d);
    }
    const width = Math.max(NODE_W, maxCols * (NODE_W + H_GAP) - H_GAP);
    // Center each layer's nodes within the widest layer for a tidier DAG.
    for (const [d, ts] of layers) {
      const layerW = ts.length * (NODE_W + H_GAP) - H_GAP;
      const offset = Math.max(0, (width - layerW) / 2);
      ts.forEach((t, i) => pos.set(t.id, { x: offset + i * (NODE_W + H_GAP), y: d * (NODE_H + V_GAP) }));
    }
    const height = tasks.length ? (maxDepth + 1) * (NODE_H + V_GAP) - V_GAP : 0;
    return { pos, width, height };
  }, [tasks]);
}

const EMPTY_TASKS: TeamTask[] = [];
const EMPTY_TEAMS: Team[] = [];

function taskVisualStatus(t: TeamTask, byId: Map<string, TeamTask>): TeamTaskStatus | "blocked" {
  // Only a real, unfinished dependency blocks — an absent id neither blocks nor draws.
  if (t.status === "pending" && t.dependsOn.some((d) => byId.has(d) && byId.get(d)!.status !== "completed")) {
    return "blocked";
  }
  return t.status;
}

const STATUS_TEXT: Record<TeamTaskStatus | "blocked", string> = {
  pending: "pending",
  in_progress: "in progress",
  completed: "done",
  blocked: "blocked",
};

export function TeamsCockpit({
  snapshot,
  onFocusAgent,
}: {
  snapshot: TeamSnapshot | null;
  onFocusAgent: (sessionId: string) => void;
}) {
  const teams = snapshot?.teams ?? EMPTY_TEAMS;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Fall back to the most-recent team if nothing is selected (or the selected
  // team ended) — the list is most-recently-active first.
  const team: Team | undefined = teams.find((t) => t.leadSessionId === selectedId) ?? teams[0];
  const tasks = team?.tasks ?? EMPTY_TASKS;
  const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const { pos, width, height } = useLayout(tasks);

  if (!snapshot || !snapshot.present || !team) {
    return (
      <div className="cockpit-empty">
        <div className="cockpit-empty-card">
          <h3>No active team</h3>
          <p>
            Ask Claude Code to "spawn a team of teammates" in a session — the roster and shared task
            graph appear here live.
          </p>
          {snapshot?.nativeStoreDetected && (
            <p className="cockpit-hint">Native Agent Teams store detected.</p>
          )}
        </div>
      </div>
    );
  }

  const done = tasks.filter((t) => t.status === "completed").length;

  return (
    <div className="cockpit">
      <div className="cockpit-head">
        <span className="cockpit-title">{team.leadLabel || "Team"}</span>
        <span className="cockpit-sub">
          {team.members.length} teammate{team.members.length === 1 ? "" : "s"} ·{" "}
          {done}/{tasks.length} tasks
        </span>
        <span className="cockpit-source" title="Source of the task graph">
          {snapshot.source === "native" ? "native store" : "via TodoWrite"}
        </span>
      </div>

      {/* switch between teams when more than one session is running a team */}
      {teams.length > 1 && (
        <div className="cockpit-switch" role="tablist" aria-label="Active teams">
          {teams.map((t) => (
            <button
              key={t.leadSessionId}
              role="tab"
              aria-selected={t.leadSessionId === team.leadSessionId}
              className={"cockpit-tab" + (t.leadSessionId === team.leadSessionId ? " active" : "")}
              onClick={() => setSelectedId(t.leadSessionId)}
              title={t.leadLabel}
            >
              <span className="cockpit-tab-name">{t.leadLabel || t.leadSessionId.slice(0, 8)}</span>
              <span className="cockpit-tab-n">{t.members.length}</span>
            </button>
          ))}
        </div>
      )}

      {/* roster */}
      <div className="cockpit-roster">
        {team.members.map((m) => (
          <button
            key={m.sessionId}
            className="teammate"
            onClick={() => onFocusAgent(m.sessionId)}
            title={m.lastAction || m.name}
          >
            <Dot status={m.status} />
            <span className="teammate-name">{m.name}</span>
            {m.spawnMode === "plan" && (
              <span className="teammate-plan" title="Read-only, awaiting plan approval">
                plan
              </span>
            )}
            <span className="teammate-meta">
              {m.agentType ? m.agentType + " · " : ""}
              {fmtTok(m.tokensTotal)} tok
            </span>
          </button>
        ))}
      </div>

      {/* task dependency graph */}
      <div className="cockpit-graph-scroll">
        {tasks.length === 0 ? (
          <div className="cockpit-hint cockpit-graph-empty">
            No shared task list yet — the lead hasn't created one.
          </div>
        ) : (
          <div className="cockpit-graph" style={{ width, height }}>
            <svg className="cockpit-edges" width={width} height={height}>
              {tasks.flatMap((t) => {
                const to = pos.get(t.id);
                if (!to) return [];
                return t.dependsOn
                  .map((depId) => {
                    const from = pos.get(depId);
                    if (!from) return null;
                    const x1 = from.x + NODE_W / 2;
                    const y1 = from.y + NODE_H;
                    const x2 = to.x + NODE_W / 2;
                    const y2 = to.y;
                    const midY = (y1 + y2) / 2;
                    return (
                      <path
                        key={`${depId}->${t.id}`}
                        className="cockpit-edge"
                        d={`M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`}
                      />
                    );
                  })
                  .filter(Boolean);
              })}
            </svg>
            {tasks.map((t) => {
              const p = pos.get(t.id);
              if (!p) return null;
              const vs = taskVisualStatus(t, byId);
              return (
                <div
                  key={t.id}
                  className={"task-node " + vs}
                  style={{ left: p.x, top: p.y, width: NODE_W, height: NODE_H }}
                >
                  <div className="task-top">
                    <span className={"task-status " + vs}>{STATUS_TEXT[vs]}</span>
                    {t.owner && <span className="task-owner">{t.owner}</span>}
                  </div>
                  <div className="task-content" title={t.content}>
                    {t.content}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {team.workflowRuns.length > 0 && (
        <div className="cockpit-workflows">
          <span className="cockpit-wf-label">workflow runs</span>
          {team.workflowRuns.map((w) => (
            <span key={w.id} className="cockpit-wf" title={w.id}>
              {w.id.replace(/^wf_/, "wf ")} · {w.agentCount} agents
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
