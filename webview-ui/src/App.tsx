import { useEffect, useMemo, useRef, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { post } from "./vscodeApi";
import { Dot, STATUS_LABEL, fmtTok, relTime } from "./ui";
import { RaceView } from "./RaceView";
import { FanoutView } from "./FanoutView";
import type {
  AgentStatus,
  AgentSummary,
  Conflict,
  ExtToWeb,
  RaceGroup,
  RouterItem,
  TranscriptMessage,
  ViewMode,
} from "./protocol";

marked.setOptions({ gfm: true, breaks: true });

function Markdown({ text }: { text: string }) {
  const html = useMemo(
    () => DOMPurify.sanitize(marked.parse(text, { async: false }) as string),
    [text],
  );
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}

function metaLine(a: AgentSummary): string {
  const bits: string[] = [];
  if (a.model) bits.push(a.model.replace(/^claude-/, ""));
  bits.push(`${fmtTok(a.tokensTotal)} tok`);
  bits.push(relTime(a.lastActivity));
  return bits.join(" · ");
}

export function App() {
  const [fleet, setFleet] = useState<AgentSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<TranscriptMessage[]>([]);
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [router, setRouter] = useState<RouterItem[]>([]);
  const [view, setView] = useState<ViewMode>("detail");
  const [race, setRace] = useState<RaceGroup | null>(null);
  const [fanoutText, setFanoutText] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onMsg = (e: MessageEvent<ExtToWeb>) => {
      const msg = e.data;
      if (msg.type === "fleet") setFleet(msg.agents);
      else if (msg.type === "selected") setSelected(msg.sessionId);
      else if (msg.type === "transcript") setTranscript(msg.messages);
      else if (msg.type === "view") setView(msg.view);
      else if (msg.type === "race") setRace(msg.group);
      else if (msg.type === "insights") {
        setConflicts(msg.conflicts);
        setRouter(msg.router);
      }
    };
    window.addEventListener("message", onMsg);
    post({ type: "ready" });
    return () => window.removeEventListener("message", onMsg);
  }, []);

  const sessions = useMemo(() => fleet.filter((a) => a.kind === "session"), [fleet]);
  const subsByParent = useMemo(() => {
    const m = new Map<string, AgentSummary[]>();
    for (const a of fleet) {
      if (a.kind === "subagent" && a.parentId) {
        const arr = m.get(a.parentId) ?? [];
        arr.push(a);
        m.set(a.parentId, arr);
      }
    }
    return m;
  }, [fleet]);

  const select = (id: string) => {
    setSelected(id);
    post({ type: "select", sessionId: id });
  };

  const switchView = (v: ViewMode) => {
    setView(v);
    post({ type: "setView", view: v });
  };

  const focused = useMemo(
    () => fleet.find((a) => a.sessionId === selected) || null,
    [fleet, selected],
  );

  // Auto-focus the running agent (or most recent) when nothing is selected.
  useEffect(() => {
    if (view !== "detail" || focused || fleet.length === 0) return;
    const pick = sessions.find((s) => s.status === "running") || sessions[0];
    if (pick) select(pick.sessionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fleet, focused, view]);

  // Auto-scroll the transcript to the newest message.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [transcript, selected]);

  const counts = useMemo(() => {
    const c: Partial<Record<AgentStatus, number>> = {};
    for (const a of sessions) c[a.status] = (c[a.status] || 0) + 1;
    return c;
  }, [sessions]);

  // Only surface subagents that are actually live — idle/done ones are noise.
  const focusedSubs =
    focused && focused.kind === "session"
      ? (subsByParent.get(focused.sessionId) || []).filter(
          (s) => s.status === "running" || s.status === "waiting" || s.status === "thinking",
        )
      : [];

  return (
    <div className="app">
      <header className="toolbar">
        <div className="counts">
          <span className="count"><Dot status="running" /> {counts.running || 0}</span>
          <span className="count"><Dot status="waiting" /> {counts.waiting || 0}</span>
          <span className="count"><Dot status="idle" /> {counts.idle || 0}</span>
        </div>
        <div className="tabs">
          <button className={"tab" + (view === "detail" ? " active" : "")} onClick={() => switchView("detail")}>
            Detail
          </button>
          {race && (
            <button className={"tab" + (view === "race" ? " active" : "")} onClick={() => switchView("race")}>
              Race
            </button>
          )}
          <button className={"tab" + (view === "fanout" ? " active" : "")} onClick={() => switchView("fanout")}>
            Fan-out
          </button>
        </div>
      </header>

      {view === "race" && <RaceView group={race} />}
      {view === "fanout" && <FanoutView text={fanoutText} onChange={setFanoutText} />}

      {view === "detail" && (
        <>
          {router.filter((r) => r.urgency !== "ok").length > 0 && (
            <section className="inbox">
              <div className="inbox-head">
                needs you {router.some((r) => r.source === "ai") ? "· AI" : ""}
              </div>
              {router
                .filter((r) => r.urgency !== "ok")
                .slice(0, 6)
                .map((r) => (
                  <div
                    key={r.sessionId}
                    className={"inbox-row " + r.urgency}
                    onClick={() => select(r.sessionId)}
                    title={r.label}
                  >
                    <span className={"urgency-pip " + r.urgency} />
                    <span className="inbox-label">{r.label}</span>
                    <span className="inbox-reason">{r.action || r.reason}</span>
                  </div>
                ))}
            </section>
          )}

          {conflicts.length > 0 && (
            <section className="conflicts">
              <div className="conflicts-head">{conflicts.length} file conflict{conflicts.length === 1 ? "" : "s"}</div>
              {conflicts.slice(0, 5).map((c) => (
                <div key={c.file} className="conflict-row" title={c.file}>
                  <span className="conflict-file">{c.file.split("/").pop()}</span>
                  <span className="conflict-agents">{c.agents.map((a) => a.label.slice(0, 18)).join(" · ")}</span>
                </div>
              ))}
            </section>
          )}

          {!focused && <div className="empty">Select an agent in the Agents list above.</div>}

          {focused && (
            <section className="focus">
              <div className="focus-title">
                <Dot status={focused.status} />
                <span className="focus-label">{focused.label || focused.sessionId.slice(0, 8)}</span>
              </div>
              <div className="focus-meta">
                <span className={"status-pill " + focused.status}>{STATUS_LABEL[focused.status]}</span>
                {!!focused.activeSubagents && (
                  <span className="status-pill thinking" title="Waiting on subagents — they're still working">
                    {focused.activeSubagents} subagent{focused.activeSubagents === 1 ? "" : "s"} working
                  </span>
                )}
                <span className="src" title={focused.statusSource === "hook" ? "from Claude Code hooks" : "inferred from transcript"}>
                  {focused.statusSource === "hook" ? "live" : "guessed"}
                </span>
                <span>{metaLine(focused)}</span>
              </div>

              {focusedSubs.length > 0 && (
                <div className="subs">
                  <div className="subs-head">{focusedSubs.length} active {focusedSubs.length === 1 ? "subagent" : "subagents"}</div>
                  {focusedSubs.map((s) => (
                    <div key={s.sessionId} className="sub-row" onClick={() => select(s.sessionId)}>
                      <Dot status={s.status} />
                      {s.agentType && <span className="badge sub">{s.agentType}</span>}
                      <span className="sub-activity">{s.liveAction || s.lastAction || s.label}</span>
                      <span className="sub-time">{relTime(s.lastActivity)}</span>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {focused && (
            <div className="transcript" ref={scrollRef}>
              {transcript.length === 0 && <div className="empty">No messages yet.</div>}
              {transcript.map((m, i) =>
                m.role === "thinking" ? (
                  <div key={i} className="msg thinking">
                    {m.text ? (
                      <>
                        <div className="msg-role">thinking</div>
                        <Markdown text={m.text} />
                      </>
                    ) : (
                      <div className="msg-role thinking-tag">Thinking…</div>
                    )}
                  </div>
                ) : (
                  <div key={i} className={"msg " + m.role}>
                    <div className="msg-role">{m.role === "tool" ? m.tool || "tool" : m.role}</div>
                    {m.role === "tool" ? (
                      <div className="msg-text">{m.text}</div>
                    ) : (
                      <Markdown text={m.text} />
                    )}
                  </div>
                ),
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
