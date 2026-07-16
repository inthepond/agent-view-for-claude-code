import { useMemo, useState, type ReactNode } from "react";
import type { AgentSummary, BoardEpisode, BoardObjectRef, SessionBoardData } from "./protocol";
import { Strip } from "../Strip";
import { Dot } from "../ui";
import { IconSend } from "./icons";
import "./lanes.css";

// The Session Board: one session materialized into swim-lanes (object type)
// by episodes (one per human prompt), time flowing left to right. Click any
// object to select it; Send hands the selection to an agent as a pointable
// referent instead of a paraphrase.

function hm(ts: number): string {
  if (!ts) return "--:--";
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function minutes(a: number, b: number): string {
  if (!a || !b || b <= a) return "";
  const m = Math.round((b - a) / 60_000);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m} min`;
}

/** Episode column letter: A..Z then A1.. — matches the header chips. */
function epName(i: number): string {
  return i < 26 ? String.fromCharCode(65 + i) : `${String.fromCharCode(65 + (i % 26))}${Math.floor(i / 26)}`;
}

function machineryLine(ep: BoardEpisode): string {
  const m = ep.machinery;
  const bits: string[] = [];
  if (m.edits) bits.push(`${m.edits} edit${m.edits === 1 ? "" : "s"}`);
  if (m.shell) bits.push(`${m.shell} shell`);
  if (m.reads) bits.push(`${m.reads} read${m.reads === 1 ? "" : "s"}`);
  if (m.other) bits.push(`${m.other} other`);
  if (m.selfHealed) bits.push(`${m.selfHealed} self-healed`);
  return bits.join(" · ") || "—";
}

export function SessionBoard(props: {
  board: SessionBoardData;
  sessions: AgentSummary[];
  onSend: (sessionId: string, objects: BoardObjectRef[]) => void;
}) {
  const { board, sessions, onSend } = props;
  const [zoom, setZoom] = useState<"glance" | "detail">("detail");
  const [selected, setSelected] = useState<Map<string, BoardObjectRef>>(new Map());
  const [sendMenu, setSendMenu] = useState(false);

  const cols = useMemo(
    () => `var(--lane-label-w) repeat(${board.episodes.length}, var(--lane-col-w))`,
    [board.episodes.length],
  );

  const toggle = (key: string, ref: BoardObjectRef) =>
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(key)) next.delete(key);
      else next.set(key, ref);
      return next;
    });

  const clear = () => {
    setSelected(new Map());
    setSendMenu(false);
  };

  const send = (sessionId: string) => {
    onSend(sessionId, [...selected.values()]);
    clear();
  };

  const obj = (key: string, ref: BoardObjectRef, className: string, children: ReactNode) => (
    <div
      key={key}
      className={className + " obj" + (selected.has(key) ? " selected" : "")}
      onClick={(e) => {
        e.stopPropagation();
        toggle(key, ref);
      }}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") toggle(key, ref);
      }}
    >
      {children}
    </div>
  );

  const jumpToTick = (_i: number, ts: number) => {
    const ep = board.episodes.find((e) => ts >= e.startTs && ts <= e.endTs) || board.episodes[0];
    document.getElementById(`ep-${board.sessionId}-${ep.index}`)?.scrollIntoView({
      behavior: "smooth",
      inline: "center",
      block: "nearest",
    });
  };

  const glance = zoom === "glance";
  const objectCount =
    board.episodes.length +
    board.totals.commits +
    (glance
      ? 0
      : board.episodes.reduce(
          (s, e) => s + e.requirements.length + e.notes.length + e.evidence.length + (e.plan ? 1 : 0) + 1,
          0,
        ) + board.shelf.length);

  return (
    <div className={"sboard" + (glance ? " glance" : "")} onClick={clear}>
      <header className="sboard-head" onClick={(e) => e.stopPropagation()}>
        <div className="sboard-title">
          <span className="sboard-label">{board.label}</span>
          {board.gitBranch && <span className="sboard-branch">{board.gitBranch}</span>}
          <span className="sboard-meta">
            {hm(board.startTs)}–{hm(board.endTs)} · {minutes(board.startTs, board.endTs)} ·{" "}
            {board.totals.events} events · {board.totals.prompts} prompts ({board.totals.words} words) ·{" "}
            {board.totals.edits} edits · {board.totals.commits} commits
          </span>
        </div>
        <div className="zoomer" role="group" aria-label="Board zoom">
          <button
            className={glance ? "active" : ""}
            aria-pressed={glance}
            onClick={() => setZoom("glance")}
          >
            Glance
          </button>
          <button
            className={!glance ? "active" : ""}
            aria-pressed={!glance}
            onClick={() => setZoom("detail")}
          >
            Detail · {objectCount}
          </button>
        </div>
      </header>

      {board.strip && (
        <div className="sboard-strip" onClick={(e) => e.stopPropagation()}>
          <Strip
            seq={board.strip.seq}
            ts={board.strip.ts}
            total={board.strip.total}
            onTick={jumpToTick}
            ariaLabel="The Scroll — click a tick to jump to its episode"
          />
        </div>
      )}

      <div className="lanes-scroll">
        <div className="lanes">
          {/* episode headers */}
          <div className="lane lane-eps" style={{ gridTemplateColumns: cols }}>
            <div className="lane-label" />
            {board.episodes.map((ep) => (
              <div className="cell ep-head" key={ep.index} id={`ep-${board.sessionId}-${ep.index}`}>
                <span className="ep-letter">{epName(ep.index)}</span>
                <span className="ep-time">
                  {hm(ep.promptTs)}
                  {minutes(ep.startTs, ep.endTs) ? ` · ${minutes(ep.startTs, ep.endTs)}` : ""}
                </span>
              </div>
            ))}
          </div>

          {/* exchanges (the spine) */}
          <div className="lane" style={{ gridTemplateColumns: cols }}>
            <div className="lane-label">Exchanges</div>
            {board.episodes.map((ep) => (
              <div className="cell" key={ep.index}>
                {obj(
                  `ex:${ep.index}`,
                  { kind: "exchange", title: ep.prompt.slice(0, 90), detail: ep.prompt, ts: ep.promptTs, episode: ep.index },
                  "exchange",
                  <>
                    <span className="ex-you">YOU · {hm(ep.promptTs)}</span>
                    <q>{ep.prompt}</q>
                    {!glance && ep.requirements.length > 0 && (
                      <div className="reqs">
                        {ep.requirements.map((r, i) =>
                          obj(
                            `req:${ep.index}:${i}`,
                            { kind: "requirement", title: r, episode: ep.index },
                            "req",
                            <>
                              <b>R{i + 1}</b> {r}
                            </>,
                          ),
                        )}
                      </div>
                    )}
                    {ep.commits.map((c, i) =>
                      obj(
                        `com:${ep.index}:${i}`,
                        { kind: "commit", title: `${c.hash} ${c.subject}`, ts: c.ts, episode: ep.index },
                        "commit",
                        <>
                          ◆ {c.hash} <i>{c.subject}</i>
                        </>,
                      ),
                    )}
                  </>,
                )}
              </div>
            ))}
          </div>

          {/* plan */}
          <div className="lane lane-fold" style={{ gridTemplateColumns: cols }}>
            <div className="lane-label">Plan</div>
            {board.episodes.map((ep) => (
              <div className="cell" key={ep.index}>
                {ep.plan
                  ? obj(
                      `plan:${ep.index}`,
                      {
                        kind: "plan",
                        title: `${ep.plan.items.filter((t) => t.status === "completed").length}/${ep.plan.items.length} tasks`,
                        detail: ep.plan.items.map((t) => `[${t.status}] ${t.content}`).join("\n"),
                        episode: ep.index,
                      },
                      "plan",
                      <>
                        <span className="tag">
                          {ep.plan.items.filter((t) => t.status === "completed").length}/{ep.plan.items.length} tasks ·{" "}
                          {ep.plan.snapshots} snapshot{ep.plan.snapshots === 1 ? "" : "s"}
                        </span>
                        <ul>
                          {ep.plan.items.map((t, i) => (
                            <li key={i} className={t.status}>
                              {t.content}
                            </li>
                          ))}
                        </ul>
                      </>,
                    )
                  : null}
              </div>
            ))}
          </div>

          {/* model notes */}
          <div className="lane lane-fold" style={{ gridTemplateColumns: cols }}>
            <div className="lane-label">Model notes</div>
            {board.episodes.map((ep) => (
              <div className="cell" key={ep.index}>
                {ep.notesDropped > 0 && <span className="dropped">+{ep.notesDropped} earlier</span>}
                {ep.notes.map((n, i) =>
                  obj(
                    `note:${ep.index}:${i}`,
                    { kind: "note", title: n.text, ts: n.ts, episode: ep.index },
                    "note",
                    <>
                      <span className="note-t">{hm(n.ts)}</span> {n.text}
                    </>,
                  ),
                )}
              </div>
            ))}
          </div>

          {/* evidence */}
          <div className="lane lane-fold" style={{ gridTemplateColumns: cols }}>
            <div className="lane-label">Evidence</div>
            {board.episodes.map((ep) => (
              <div className="cell chips" key={ep.index}>
                {ep.evidence.map((ev, i) =>
                  obj(
                    `ev:${ep.index}:${i}`,
                    { kind: "evidence", title: ev, episode: ep.index },
                    "ev",
                    <>▣ {ev}</>,
                  ),
                )}
              </div>
            ))}
          </div>

          {/* machinery */}
          <div className="lane lane-fold" style={{ gridTemplateColumns: cols }}>
            <div className="lane-label">Machinery</div>
            {board.episodes.map((ep) => (
              <div className="cell" key={ep.index}>
                {obj(
                  `mach:${ep.index}`,
                  { kind: "machinery", title: machineryLine(ep), episode: ep.index },
                  "machine",
                  <>
                    {machineryLine(ep)}
                    {ep.machinery.stallMin && (
                      <span className="stall">⚠ {ep.machinery.stallMin}-min silent stall</span>
                    )}
                    {ep.machinery.errors.map((e, i) => (
                      <span className="err" key={i}>
                        ✗ {e}
                      </span>
                    ))}
                  </>,
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {!glance && board.shelf.length > 0 && (
        <div className="shelf" onClick={(e) => e.stopPropagation()}>
          <span className="shelf-head">
            Artifact shelf — {board.shelf.length}
            {board.shelfDropped > 0 ? `+${board.shelfDropped}` : ""} files · {board.totals.edits} edits
          </span>
          <div className="shelf-files">
            {board.shelf.map((f) => (
              <span className="shelf-file" key={f.file} title={f.file}>
                <i style={{ width: Math.min(60, f.edits * 3) }} />
                <b>{f.edits}</b> {f.file.split("/").pop()}
              </span>
            ))}
          </div>
        </div>
      )}

      {selected.size > 0 && (
        <div className="sel-bar" role="toolbar" aria-label="Selection actions" onClick={(e) => e.stopPropagation()}>
          <span className="sel-count">{selected.size} selected</span>
          <span className="sel-div" />
          <div className="send-wrap">
            <button
              className="dock-btn dock-btn-primary"
              onClick={() => setSendMenu((v) => !v)}
              aria-expanded={sendMenu}
              title="Point the selected objects out to an agent"
            >
              <IconSend />
              <span className="dock-btn-label">Send</span>
            </button>
            {sendMenu && (
              <div className="send-menu" role="menu">
                {sessions.length === 0 && <div className="send-empty">No agents running</div>}
                {sessions.map((a) => (
                  <div key={a.sessionId} className="send-row" role="menuitem" onClick={() => send(a.sessionId)}>
                    <Dot status={a.status} />
                    <span>{a.label || a.sessionId.slice(0, 8)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
