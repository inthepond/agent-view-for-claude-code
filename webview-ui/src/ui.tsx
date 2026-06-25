// Small presentational helpers shared by the Detail, Race, and Fan-out views.
import type { AgentStatus } from "./protocol";

export const STATUS_COLOR: Record<AgentStatus, string> = {
  running: "var(--vscode-charts-green, #89d185)",
  thinking: "var(--vscode-charts-purple, #b180d7)",
  waiting: "var(--vscode-charts-yellow, #e2c08d)",
  idle: "var(--vscode-descriptionForeground, #888)",
  done: "var(--vscode-charts-blue, #75beff)",
  error: "var(--vscode-charts-red, #f48771)",
  unknown: "var(--vscode-descriptionForeground, #888)",
};

export const STATUS_LABEL: Record<AgentStatus, string> = {
  running: "running",
  thinking: "thinking",
  waiting: "waiting for input",
  idle: "idle",
  done: "done",
  error: "error",
  unknown: "unknown",
};

export function relTime(ms: number): string {
  if (!ms) return "—";
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function fmtTok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return `${n}`;
}

export function Dot({ status }: { status: AgentStatus }) {
  return (
    <span
      className={status === "running" || status === "thinking" ? "dot pulse" : "dot"}
      style={{ background: STATUS_COLOR[status] }}
      title={STATUS_LABEL[status]}
    />
  );
}
