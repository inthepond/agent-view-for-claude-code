import * as fs from "fs";
import { AgentStatus, TokenUsage, emptyTokens } from "./types";
import { stripMarkdown } from "./util/markdown";
import { humanizeTool } from "./util/format";

/** Lines we treat as conversational turns (others are metadata/snapshots). */
const TURN_TYPES = new Set(["user", "assistant"]);

/** Tools whose input names a file the agent modified. */
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "str_replace_based_edit_tool"]);

/** If a transcript is larger than this, only the tail is read for status. */
const MAX_FULL_READ_BYTES = 8 * 1024 * 1024;
const TAIL_BYTES = 512 * 1024;

/**
 * Heuristic-only "running" window. Without hooks we can't truly know if an
 * agent is executing, so we only call it "running" if it wrote very recently;
 * otherwise it's treated as idle. (Hooks, when present, override this.)
 */
const RUNNING_WINDOW_MS = 30_000;

export interface TranscriptSummary {
  label: string;
  /** Claude Code's own self-updating session title, if it has generated one. */
  aiTitle?: string;
  status: AgentStatus;
  model?: string;
  gitBranch?: string;
  cwd?: string;
  tokens: TokenUsage;
  lastActivity: number;
  messageCount: number;
  /** A short summary of the most recent thing the agent did. */
  lastAction?: string;
  /** Files the agent edited/wrote (for conflict detection). */
  filesTouched: string[];
}

/** Tolerant per-line JSON parse — skips malformed/partial lines. */
function parseLines(raw: string): any[] {
  const out: any[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      // partial write or non-JSON line — ignore
    }
  }
  return out;
}

/** True for slash-command / system wrapper messages that aren't a real prompt. */
function isWrapperText(text: string): boolean {
  return /^\s*<(local-command-caveat|local-command-stdout|command-message|command-name|command-args|system-reminder|user-prompt-submit-hook)/i.test(
    text,
  );
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b: any) => (b && typeof b === "object" && typeof b.text === "string" ? b.text : ""))
      .join("")
      .trim();
  }
  return "";
}

function tsOf(line: any): number {
  const t = line?.timestamp;
  if (typeof t === "string") {
    const ms = Date.parse(t);
    if (!Number.isNaN(ms)) return ms;
  }
  return 0;
}

function deriveStatus(lines: any[], lastActivity: number): AgentStatus {
  let last: any | undefined;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (TURN_TYPES.has(lines[i]?.type)) {
      last = lines[i];
      break;
    }
  }
  if (!last) return "unknown";

  const ageMs = Date.now() - lastActivity;

  if (last.type === "user") {
    // user just prompted -> model is (or will be) working, unless stale
    return ageMs > RUNNING_WINDOW_MS ? "idle" : "running";
  }

  // assistant
  const stop = last.message?.stop_reason;
  const text = contentToText(last.message?.content);
  if (stop === "tool_use") {
    return ageMs > RUNNING_WINDOW_MS ? "idle" : "running";
  }
  if (text.trimEnd().endsWith("?")) return "waiting";
  if (stop === "end_turn" || stop === "stop_sequence" || stop === "max_tokens") return "idle";
  return ageMs > RUNNING_WINDOW_MS ? "idle" : "running";
}

export function parseTranscript(jsonlPath: string): TranscriptSummary | null {
  let raw: string;
  try {
    const stat = fs.statSync(jsonlPath);
    if (stat.size > MAX_FULL_READ_BYTES) {
      const fd = fs.openSync(jsonlPath, "r");
      try {
        const start = Math.max(0, stat.size - TAIL_BYTES);
        const buf = Buffer.alloc(stat.size - start);
        fs.readSync(fd, buf, 0, buf.length, start);
        raw = buf.toString("utf8");
      } finally {
        fs.closeSync(fd);
      }
    } else {
      raw = fs.readFileSync(jsonlPath, "utf8");
    }
  } catch {
    return null;
  }

  const lines = parseLines(raw);
  if (lines.length === 0) return null;

  const tokens = emptyTokens();
  let model: string | undefined;
  let gitBranch: string | undefined;
  let cwd: string | undefined;
  let firstUserText = "";
  let firstAssistantText = "";
  let aiTitle = "";
  let lastActivity = 0;
  let messageCount = 0;
  let lastAction = "";
  const filesTouched = new Set<string>();

  for (const line of lines) {
    const ts = tsOf(line);
    if (ts > lastActivity) lastActivity = ts;
    if (typeof line.cwd === "string") cwd = line.cwd;
    if (typeof line.gitBranch === "string") gitBranch = line.gitBranch;

    if (line.type === "ai-title") {
      // Claude Code stores the title in `aiTitle`; the rest are defensive
      // fallbacks in case the (undocumented) line shape changes.
      aiTitle =
        line.aiTitle || line.title || line.message?.title || contentToText(line.message?.content) || aiTitle;
      continue;
    }
    if (!TURN_TYPES.has(line.type)) continue;
    messageCount++;

    if (line.type === "user" && !firstUserText && !line.isSidechain) {
      const t = contentToText(line.message?.content);
      if (t && !isWrapperText(t)) firstUserText = t;
    }
    if (line.type === "assistant") {
      const m = line.message;
      const content = m?.content;
      if (!firstAssistantText) {
        const t = contentToText(content);
        if (t) firstAssistantText = t;
      }
      // Track the most recent thing the agent did: last tool call (humanized
      // into a "now doing X" phrase), else a short snippet of its reply.
      let act = "";
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b?.type === "tool_use") {
            act = humanizeTool(b.name, b.input);
            if (EDIT_TOOLS.has(b.name)) {
              const f = b.input?.file_path || b.input?.path || b.input?.notebook_path;
              if (typeof f === "string") filesTouched.add(f);
            }
          }
        }
      }
      // A plain-text reply means the agent is talking, not acting — keep it
      // brief (this feeds the one-line ambient overview, not the transcript).
      if (!act) act = stripMarkdown(contentToText(content));
      if (act) lastAction = act.replace(/\s+/g, " ").slice(0, 280);
      if (m?.model) model = m.model;
      const u = m?.usage;
      if (u) {
        tokens.output += u.output_tokens || 0;
        // last assistant usage reflects current context window occupancy
        tokens.input = u.input_tokens || tokens.input;
        tokens.cacheRead = u.cache_read_input_tokens || tokens.cacheRead;
        tokens.cacheCreate = u.cache_creation_input_tokens || tokens.cacheCreate;
      }
    }
  }

  const cleanAiTitle = aiTitle ? stripMarkdown(aiTitle).slice(0, 80) : undefined;
  const label =
    cleanAiTitle ||
    stripMarkdown(firstUserText || firstAssistantText || "(no prompt yet)").slice(0, 80);
  const status = deriveStatus(lines, lastActivity);

  return {
    label,
    aiTitle: cleanAiTitle,
    status,
    model,
    gitBranch,
    cwd,
    tokens,
    lastActivity,
    messageCount,
    lastAction: lastAction || undefined,
    filesTouched: [...filesTouched],
  };
}

export interface FlatMessage {
  role: "user" | "assistant" | "tool";
  text: string;
  ts: number;
  tool?: string;
}

/** Flatten a transcript into displayable messages (most recent `limit`). */
export function readMessages(jsonlPath: string, limit = 200): FlatMessage[] {
  let raw: string;
  try {
    raw = fs.readFileSync(jsonlPath, "utf8");
  } catch {
    return [];
  }
  const out: FlatMessage[] = [];
  for (const line of parseLines(raw)) {
    if (!TURN_TYPES.has(line.type)) continue;
    const ts = tsOf(line);
    const content = line.message?.content;
    if (line.type === "user") {
      const text = contentToText(content);
      if (text) out.push({ role: "user", text, ts });
      continue;
    }
    // assistant: emit text + a line per tool_use
    const text = contentToText(content);
    if (text) out.push({ role: "assistant", text, ts });
    if (Array.isArray(content)) {
      for (const b of content) {
        if (b?.type === "tool_use") {
          out.push({ role: "tool", tool: b.name, text: describeToolInput(b.name, b.input), ts });
        }
      }
    }
  }
  return out.slice(-limit);
}

/** Fuller, readable rendering of a tool call's input for the transcript view. */
function describeToolInput(name: string, input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, any>;

  // AskUserQuestion: expand questions + options instead of dumping raw JSON.
  if (name === "AskUserQuestion" && Array.isArray(o.questions)) {
    return o.questions
      .map((q: any) => {
        const opts = Array.isArray(q?.options)
          ? q.options
              .map((op: any) => `  • ${op?.label ?? ""}${op?.description ? " — " + op.description : ""}`)
              .join("\n")
          : "";
        return `Q: ${q?.question ?? ""}${q?.multiSelect ? " (multi-select)" : ""}${opts ? "\n" + opts : ""}`;
      })
      .join("\n\n");
  }

  // High-signal single fields shown in full (no truncation).
  if (typeof o.command === "string") return o.command;
  if (typeof o.file_path === "string") return o.file_path;
  if (typeof o.path === "string") return o.path;
  if (typeof o.notebook_path === "string") return o.notebook_path;
  if (typeof o.pattern === "string") return o.pattern;
  if (typeof o.prompt === "string") return o.prompt;
  if (typeof o.description === "string") return o.description;

  // Anything else: pretty-printed JSON, generously capped.
  try {
    return JSON.stringify(o, null, 2).slice(0, 4000);
  } catch {
    return "";
  }
}
