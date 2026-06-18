import * as vscode from "vscode";
import { AgentStatus, TokenUsage } from "../types";

export function relativeTime(ms: number): string {
  if (!ms) return "—";
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function formatTokens(t: TokenUsage): string {
  const total = t.input + t.output + t.cacheRead + t.cacheCreate;
  if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(1)}M tok`;
  if (total >= 1000) return `${(total / 1000).toFixed(1)}k tok`;
  return `${total} tok`;
}

const STATUS_META: Record<AgentStatus, { icon: string; color: string; emoji: string }> = {
  running: { icon: "loading~spin", color: "charts.green", emoji: "🟢" },
  waiting: { icon: "warning", color: "charts.yellow", emoji: "🟡" },
  idle: { icon: "circle-outline", color: "descriptionForeground", emoji: "⚪" },
  done: { icon: "pass", color: "charts.blue", emoji: "🔵" },
  error: { icon: "error", color: "charts.red", emoji: "🔴" },
  unknown: { icon: "question", color: "descriptionForeground", emoji: "❔" },
};

export function statusIcon(status: AgentStatus): vscode.ThemeIcon {
  const m = STATUS_META[status] || STATUS_META.unknown;
  return new vscode.ThemeIcon(m.icon, new vscode.ThemeColor(m.color));
}

export function statusEmoji(status: AgentStatus): string {
  return (STATUS_META[status] || STATUS_META.unknown).emoji;
}

/** Trim a string to a max length, adding an ellipsis when cut. */
export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}
