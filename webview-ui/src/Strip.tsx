import { useMemo } from "react";
import "./strip.css";

// The Scroll: a session's every conversational event as one tick, in order.
// Char classes come from the host (src/transcript.ts readEventStrip):
// H you · T model prose · K thinking · E/B/R/D/S tool calls · r result · m meta

const TICK_LABEL: Record<string, string> = {
  H: "you",
  T: "model prose",
  K: "model thinking",
  E: "edit/write",
  B: "shell",
  R: "read",
  D: "todo update",
  S: "tool call",
  r: "tool result",
  m: "system",
};

/** Tool-call chars share one visual class; the rest are their own. */
function tickClass(c: string): string {
  if (c === "E" || c === "B" || c === "R" || c === "D" || c === "S") return "u";
  return c;
}

export function Strip(props: {
  seq: string;
  ts?: number[];
  /** Pre-downsampling event count, when the seq is a sample of it. */
  total?: number;
  onTick?: (index: number, ts: number) => void;
  /** Compact renders thinner ticks for tight surfaces (fleet rows). */
  compact?: boolean;
  ariaLabel?: string;
}) {
  const { seq, ts, total, onTick, compact, ariaLabel } = props;
  const ticks = useMemo(() => seq.split(""), [seq]);
  const humans = useMemo(() => ticks.filter((c) => c === "H").length, [ticks]);
  return (
    <div
      className={"strip" + (compact ? " compact" : "") + (onTick ? " clickable" : "")}
      role={onTick ? "toolbar" : "img"}
      aria-label={
        ariaLabel ||
        `${total || ticks.length} events, ${humans} human prompt${humans === 1 ? "" : "s"}`
      }
    >
      {ticks.map((c, i) => (
        <span
          key={i}
          className={"tick tick-" + tickClass(c)}
          title={`${i + 1}/${total || ticks.length} · ${TICK_LABEL[c] || "event"}`}
          onClick={onTick && ts ? () => onTick(i, ts[i] || 0) : undefined}
        />
      ))}
    </div>
  );
}
