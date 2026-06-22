import type { RaceGroup } from "./protocol";
import { post } from "./vscodeApi";
import { Dot, fmtTok } from "./ui";

export function RaceView({ group }: { group: RaceGroup | null }) {
  if (!group) {
    return (
      <div className="empty">
        No active race. Run <b>Agent View: Race Agents</b> from the Command Palette (or the rocket button on the
        Agents list toolbar) to start one.
      </div>
    );
  }

  const total = group.candidates.length;
  const done = group.candidates.filter(
    (c) => c.status === "idle" || c.status === "done" || c.status === "error",
  ).length;

  return (
    <section className="race">
      <div className="race-head">
        <div className="race-title">🏁 Race · {total} agents</div>
        <div className="race-progress">{done}/{total} done</div>
      </div>
      <div className="race-task" title={group.task}>{group.task}</div>

      <div className="race-actions">
        <button className="btn" onClick={() => post({ type: "openAllDiffs", groupId: group.groupId })}>
          Open all diffs
        </button>
        <button className="btn" onClick={() => post({ type: "rankRace", groupId: group.groupId })} title="Rank with Merge Advisor (uses your Claude subscription)">
          Rank with AI
        </button>
        <button className="btn ghost" onClick={() => post({ type: "cleanupRace", groupId: group.groupId })}>
          Clean up
        </button>
      </div>

      <div className="race-grid">
        {group.candidates.map((c) => {
          const isWinner = group.winnerId === c.sessionId;
          return (
            <div
              key={c.sessionId}
              className={"race-card" + (isWinner ? " winner" : "") + (c.recommended ? " recommended" : "")}
            >
              <div className="race-card-head">
                <Dot status={c.status} />
                <span className="race-card-name" title={c.label}>
                  #{c.index + 1}
                  {c.branch ? " · " + c.branch.replace(/^mas\//, "") : ""}
                </span>
                {typeof c.score === "number" && (
                  <span className="race-score" title="AI rank score">
                    {c.recommended ? "⭐ " : ""}
                    {c.score}
                  </span>
                )}
              </div>
              <div className="race-now" title={c.liveAction || c.lastAction || ""}>
                {c.liveAction || c.lastAction || (c.status === "unknown" ? "starting…" : "…")}
              </div>
              <div className="race-meta">
                {fmtTok(c.tokensTotal)} tok · {c.status}
              </div>
              <div className="race-card-actions">
                <button
                  className="btn tiny"
                  disabled={c.status === "unknown"}
                  onClick={() => post({ type: "openCandidateDiff", sessionId: c.sessionId })}
                >
                  Diff
                </button>
                <button className="btn tiny" onClick={() => post({ type: "select", sessionId: c.sessionId })}>
                  Transcript
                </button>
                <button
                  className={"btn tiny pick" + (isWinner ? " active" : "")}
                  disabled={c.status === "unknown"}
                  onClick={() => post({ type: "pickWinner", sessionId: c.sessionId })}
                >
                  {isWinner ? "✓ Winner" : "Pick winner"}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <p className="race-foot">
        Picking a winner opens its diff and copies the merge command — nothing is merged or deleted automatically.
      </p>
    </section>
  );
}
