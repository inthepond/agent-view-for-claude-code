import { useEffect, useMemo, useState } from "react";
import type { AgentSummary } from "../protocol";
import type { BoardObjectRef, ExtToBoard, SessionBoardData, TeamSnapshot } from "./protocol";
import { post } from "./api";
import { SessionBoard } from "./SessionBoard";
import { TeamsCockpit } from "./TeamsCockpit";
import { Dot, fmtTok, relTime } from "../ui";
import { IconAgent, IconHistory, IconTeam } from "./icons";

// The Session Board app: a fleet list (pick a session) over the materialized
// board of the selected session. The free-form pin canvas this replaced lives
// on only as the selection.json envelope agents already know how to read.

export function BoardApp() {
  const [fleet, setFleet] = useState<AgentSummary[]>([]);
  const [board, setBoard] = useState<SessionBoardData | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [recency, setRecency] = useState({ showOlder: false, hiddenCount: 0 });
  const [teams, setTeams] = useState<TeamSnapshot | null>(null);
  const [mode, setMode] = useState<"board" | "teams">("board");

  useEffect(() => {
    const onMsg = (e: MessageEvent<ExtToBoard>) => {
      const m = e.data;
      if (m.type === "fleet") setFleet(m.agents);
      else if (m.type === "sessionBoard") setBoard(m.board);
      else if (m.type === "meta") setRecency({ showOlder: m.showOlder, hiddenCount: m.hiddenCount });
      else if (m.type === "teams") setTeams(m.snapshot);
    };
    window.addEventListener("message", onMsg);
    post({ type: "ready" });
    return () => window.removeEventListener("message", onMsg);
  }, []);

  const sessions = useMemo(() => fleet.filter((a) => a.kind === "session"), [fleet]);

  const counts = useMemo(() => {
    const c = { running: 0, waiting: 0 };
    for (const a of sessions) {
      if (a.status === "running") c.running++;
      else if (a.status === "waiting") c.waiting++;
    }
    return c;
  }, [sessions]);

  const open = (id: string) => {
    setSelectedId(id);
    setBoard(null);
    post({ type: "selectSession", sessionId: id });
  };

  const back = () => {
    setSelectedId(null);
    setBoard(null);
    post({ type: "selectSession", sessionId: null });
  };

  const sendObjects = (sessionId: string, objects: BoardObjectRef[]) =>
    post({ type: "sendToAgent", sessionId, objects });

  const selectedAgent = useMemo(
    () => sessions.find((a) => a.sessionId === selectedId) || null,
    [sessions, selectedId],
  );

  return (
    <div className="board">
      <div className="board-chip" role="status">
        <span className="board-chip-title">Session Board</span>
        <span className="board-chip-counts">
          <span className="board-chip-pill run">{counts.running} running</span>
          <span className="board-chip-pill wait">{counts.waiting} waiting</span>
        </span>
      </div>

      {/* main dock — bottom-center floating pill */}
      <div className="board-dock" role="toolbar" aria-label="Board tools">
        <div className="dock-group">
          {selectedId && (
            <button className="dock-btn labeled" onClick={back} title="Back to all agents">
              <span className="dock-btn-label">← Agents</span>
            </button>
          )}
          <button className="dock-btn" onClick={() => post({ type: "newAgent" })} title="Spawn a new agent">
            <IconAgent />
          </button>
          <button
            className={"dock-btn labeled" + (mode === "teams" ? " active" : "")}
            onClick={() => setMode((mm) => (mm === "teams" ? "board" : "teams"))}
            title={mode === "teams" ? "Back to the board" : "Open the Teams cockpit"}
            aria-pressed={mode === "teams"}
          >
            <IconTeam />
            <span className="dock-btn-label">Teams</span>
            {teams?.present && mode !== "teams" && <span className="dock-dot" />}
          </button>
          {(recency.showOlder || recency.hiddenCount > 0) && (
            <button
              className={"dock-btn" + (recency.showOlder ? " active" : "")}
              onClick={() => post({ type: "toggleOlder" })}
              title={
                recency.showOlder
                  ? "Showing all agents — click to hide older idle ones"
                  : `Show ${recency.hiddenCount} older idle agent${recency.hiddenCount === 1 ? "" : "s"}`
              }
            >
              <IconHistory />
            </button>
          )}
        </div>
      </div>

      {mode === "board" && !selectedId && (
        <div className="fleet-home">
          <h3 className="fleet-title">Pick a session to materialize</h3>
          <p className="fleet-sub">
            Every session renders as a board — episodes, plans, commits, evidence — instead of a scroll.
          </p>
          {sessions.length === 0 && (
            <div className="fleet-empty">
              No Claude Code sessions found yet. Spawn one with the robot button below.
            </div>
          )}
          <div className="fleet-rows">
            {sessions.map((a) => (
              <div
                key={a.sessionId}
                className="fleet-row"
                onClick={() => open(a.sessionId)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter") open(a.sessionId);
                }}
              >
                <Dot status={a.status} />
                <span className="fleet-label" title={a.label}>
                  {a.label || a.sessionId.slice(0, 8)}
                </span>
                {a.plan && a.plan.total > 0 && (
                  <span className="fleet-plan">
                    {a.plan.done}/{a.plan.total}
                  </span>
                )}
                {a.lastError && (
                  <span className="fleet-err" title={a.lastError}>
                    red
                  </span>
                )}
                <span className="fleet-meta">
                  {fmtTok(a.tokensTotal)} tok · {relTime(a.lastActivity)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {mode === "board" && selectedId && !board && (
        <div className="fleet-home">
          <div className="fleet-empty">Materializing session…</div>
        </div>
      )}

      {mode === "board" && selectedId && board && (
        <div className="sboard-frame">
          <div className="sboard-actions">
            <button onClick={() => post({ type: "focusAgent", sessionId: board.sessionId })}>
              Focus in Detail
            </button>
            {selectedAgent?.managed && (
              <button onClick={() => post({ type: "openDiff", sessionId: board.sessionId })}>
                Open diff
              </button>
            )}
          </div>
          <SessionBoard board={board} sessions={sessions} onSend={sendObjects} />
        </div>
      )}

      {mode === "teams" && (
        <div className="cockpit-overlay">
          <TeamsCockpit
            snapshot={teams}
            onFocusAgent={(id) => post({ type: "focusAgent", sessionId: id })}
          />
        </div>
      )}
    </div>
  );
}
