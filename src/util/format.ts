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

function oneLine(s: unknown, max: number): string {
  return typeof s === "string" ? truncate(s.replace(/\s+/g, " ").trim(), max) : "";
}

function basename(p: unknown): string | undefined {
  if (typeof p !== "string" || !p) return undefined;
  return p.split(/[\\/]/).pop() || p;
}

/**
 * Turn a tool call into a short, human-readable "now doing X" phrase, e.g.
 * "Editing auth.ts", "Running: npm test", "Searching: TODO". Used both for the
 * transcript-derived `lastAction` and the live hook-driven action, so the
 * phrasing stays consistent across the tree and the detail panel.
 */
export function humanizeTool(name: string, input: unknown): string {
  const o = input && typeof input === "object" ? (input as Record<string, any>) : {};
  switch (name) {
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "str_replace_based_edit_tool":
      return `Editing ${basename(o.file_path || o.path) ?? "a file"}`;
    case "NotebookEdit":
      return `Editing ${basename(o.notebook_path || o.file_path) ?? "a notebook"}`;
    case "Read":
      return `Reading ${basename(o.file_path || o.path || o.notebook_path) ?? "a file"}`;
    case "Bash": {
      const d = oneLine(o.description, 80) || oneLine(o.command, 80);
      return d ? `Running: ${d}` : "Running a command";
    }
    case "Grep":
      return `Searching: ${oneLine(o.pattern, 60) || "…"}`;
    case "Glob":
      return `Finding: ${oneLine(o.pattern, 60) || "files"}`;
    case "Task":
    case "Agent":
      return `Delegating: ${oneLine(o.description || o.subagent_type, 60) || "a subagent"}`;
    case "WebFetch":
      return `Fetching ${oneLine(o.url, 60) || "a page"}`;
    case "WebSearch":
      return `Searching web: ${oneLine(o.query, 60) || "…"}`;
    case "TodoWrite":
      return "Updating the plan";
    case "AskUserQuestion":
      return "Asking you a question";
    default: {
      const detail = oneLine(
        o.command || o.file_path || o.path || o.pattern || o.description || o.prompt || o.url || o.query,
        70,
      );
      return detail ? `${name}: ${detail}` : name || "Working";
    }
  }
}
