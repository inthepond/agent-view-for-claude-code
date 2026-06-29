import type { AgentSummary } from "../protocol";
import type { BoardCard } from "./protocol";
import { Dot, fmtTok, relTime } from "../ui";

const stop = (e: { stopPropagation(): void }) => e.stopPropagation();

/** Live agent card — a transient projection of one AgentSummary. */
export function AgentCardView(props: {
  agent: AgentSummary;
  subCount: number;
  expanded: boolean;
  canSend: boolean;
  onPinDiff: () => void;
  onPinOutput: () => void;
  onDiff: () => void;
  onSendHere: () => void;
  onToggleSubs: () => void;
}) {
  const a = props.agent;
  const working = (a.activeSubagents ?? 0) > 0;
  return (
    <div className={"node agent status-" + a.status + (working ? " working" : "")}>
      <div className="agent-head">
        <Dot status={working && a.status !== "running" ? "running" : a.status} />
        <span className="agent-label" title={a.label}>
          {a.label || a.sessionId.slice(0, 8)}
        </span>
      </div>
      <div className="agent-activity">
        {working
          ? `${a.activeSubagents} subagent${a.activeSubagents === 1 ? "" : "s"} working`
          : a.lastError || a.liveAction || a.lastAction || "idle"}
      </div>
      <div className="agent-meta">
        {a.gitBranch && <span className="chip">{a.gitBranch}</span>}
        {a.plan && a.plan.total > 0 && (
          <span className="chip plan" title={a.plan.current || "plan progress"}>
            {a.plan.done}/{a.plan.total}
          </span>
        )}
        <span className="chip">{fmtTok(a.tokensTotal)} tok</span>
        {props.subCount > 0 && (
          <button
            className={"chip subs-toggle" + (props.expanded ? " on" : "") + (working ? " working" : "")}
            onPointerDown={stop}
            onClick={props.onToggleSubs}
            title={props.expanded ? "Hide subagents" : "Show subagents"}
          >
            {props.subCount} sub{props.subCount === 1 ? "" : "s"} {props.expanded ? "v" : ">"}
          </button>
        )}
        <span className="chip time">{relTime(a.lastActivity)}</span>
      </div>
      <div className="agent-actions">
        {a.managed ? (
          <>
            <button onPointerDown={stop} onClick={props.onPinDiff} title="Pin this agent's current diff to the board">
              Pin diff
            </button>
            <button onPointerDown={stop} onClick={props.onDiff} title="Open this agent's diff">
              Diff
            </button>
          </>
        ) : (
          <button onPointerDown={stop} onClick={props.onPinOutput} title="Pin this agent's latest output to the board">
            Pin output
          </button>
        )}
        {props.canSend && (
          <button className="send" onPointerDown={stop} onClick={props.onSendHere} title="Send the selected cards to this agent">
            Send
          </button>
        )}
      </div>
    </div>
  );
}

/** Compact card for a subagent (shown when its parent is expanded). */
export function SubAgentCardView({ agent }: { agent: AgentSummary }) {
  const a = agent;
  return (
    <div className={"node subagent status-" + a.status}>
      <div className="agent-head">
        <Dot status={a.status} />
        <span className="agent-label" title={a.label}>
          {a.agentType || a.label || a.sessionId.slice(0, 8)}
        </span>
      </div>
      <div className="agent-activity">{a.liveAction || a.lastAction || a.label || "idle"}</div>
      <div className="agent-meta">
        <span className="chip">{fmtTok(a.tokensTotal)} tok</span>
        <span className="chip time">{relTime(a.lastActivity)}</span>
      </div>
    </div>
  );
}

function diffLineClass(ln: string): string {
  if (ln.startsWith("+") && !ln.startsWith("+++")) return "dl add";
  if (ln.startsWith("-") && !ln.startsWith("---")) return "dl del";
  if (ln.startsWith("@@")) return "dl hunk";
  return "dl";
}

export function DiffCardView({ card }: { card: BoardCard }) {
  const lines = (card.diffText || "").split("\n").slice(0, 400);
  return (
    <div className="node card diff">
      <div className="card-head">
        <span className="card-kind">diff</span>
        <span className="card-title" title={card.title}>
          {card.title}
        </span>
      </div>
      <div className="card-sub">
        {card.branch && <span className="chip">{card.branch}</span>}
        {card.pinnedAtCommit && <span className="chip">pinned @ {card.pinnedAtCommit.slice(0, 7)}</span>}
      </div>
      <pre className="diff-body" onPointerDown={stop} onWheel={stop}>
        {lines.map((ln, i) => (
          <div key={i} className={diffLineClass(ln)}>
            {ln || " "}
          </div>
        ))}
      </pre>
    </div>
  );
}

export function TextCardView(props: {
  card: BoardCard;
  editing: boolean;
  onStartEdit: () => void;
  onEdit: (body: string) => void;
}) {
  const c = props.card;
  return (
    <div className={"node card text kind-" + c.kind}>
      <div className="card-head">
        <span className="card-kind">
          {c.kind}
          {c.createdBy === "agent" ? " · agent" : ""}
        </span>
        <span className="card-title" title={c.title}>
          {c.title}
        </span>
      </div>
      {props.editing ? (
        <textarea
          className="card-edit"
          autoFocus
          defaultValue={c.body || ""}
          onPointerDown={stop}
          onWheel={stop}
          onBlur={(e) => props.onEdit(e.target.value)}
        />
      ) : (
        <div className="card-body" onPointerDown={stop} onWheel={stop} onDoubleClick={props.onStartEdit}>
          {c.body ? c.body : <span className="muted">Double-click to write…</span>}
        </div>
      )}
      {c.filePath && (
        <div className="card-sub">
          <span className="chip">{c.filePath}</span>
        </div>
      )}
    </div>
  );
}
