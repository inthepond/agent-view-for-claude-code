import * as fs from "fs";
import { AgentStatus, TokenUsage, emptyTokens, PlanProgress } from "./types";
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

/**
 * A thinking phase can run far longer than the running window (extended thinking
 * on big models), so we trust a "still thinking" reading for longer before
 * giving up on it.
 */
const THINKING_WINDOW_MS = 5 * 60_000;

/**
 * A tool failure only counts as the agent's *current* state for this long. An
 * agent that errored an hour ago and went quiet isn't "needs you" anymore.
 */
const ERROR_WINDOW_MS = 5 * 60_000;

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
  /** The agent's own TodoWrite plan progress, if it has one. */
  plan?: PlanProgress;
  /**
   * Reason the agent's most recent tool ended in failure (e.g. "Bash failed:
   * npm test exited 1"). Only set while still the latest tool — cleared once a
   * later tool succeeds, so it reads "currently red", not "ever failed".
   */
  lastError?: string;
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

/** True if an assistant message contains an extended-thinking block. */
function hasThinkingBlock(content: unknown): boolean {
  return (
    Array.isArray(content) &&
    content.some((b: any) => b?.type === "thinking" || b?.type === "redacted_thinking")
  );
}

/**
 * Concatenated plaintext of any thinking blocks. Recent models persist thinking
 * as signature-only (the `thinking` field is empty), so this is often "".
 */
function thinkingText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((b: any) => (b?.type === "thinking" && typeof b.thinking === "string" ? b.thinking : ""))
    .join("")
    .trim();
}

/** Roll a TodoWrite todos array up into done/total/current progress. */
function planFromTodos(todos: any[] | undefined): PlanProgress | undefined {
  if (!Array.isArray(todos) || todos.length === 0) return undefined;
  let done = 0;
  let current: string | undefined;
  for (const t of todos) {
    if (t?.status === "completed") {
      done++;
    } else if (t?.status === "in_progress" && !current) {
      const c =
        (typeof t.activeForm === "string" && t.activeForm) ||
        (typeof t.content === "string" ? t.content : "");
      if (c) current = c.replace(/\s+/g, " ").slice(0, 80);
    }
  }
  return { done, total: todos.length, current };
}

/** First useful line of a failed tool result, prefixed with the tool name. */
function errorReason(tool: string, block: any, toolUseResult: any): string {
  let detail = "";
  const stderr = toolUseResult && typeof toolUseResult === "object" ? toolUseResult.stderr : undefined;
  if (typeof stderr === "string" && stderr.trim()) {
    detail = stderr.trim().split("\n").find((l) => l.trim()) || "";
  } else {
    const c = block?.content;
    if (typeof c === "string") {
      detail = c.trim();
    } else if (Array.isArray(c)) {
      detail = c.map((x: any) => (x && typeof x.text === "string" ? x.text : "")).join(" ").trim();
    }
    detail = detail.split("\n").find((l) => l.trim()) || "";
  }
  detail = detail
    .replace(/<\/?tool_use_error>/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return detail ? `${tool} failed: ${detail}` : `${tool} failed`;
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
  const content = last.message?.content;
  const stop = last.message?.stop_reason;
  const text = contentToText(content);
  // Claude Code writes a thinking block as its own assistant line (split by
  // content block); a thinking-only last turn means the model is mid-reasoning,
  // which the 30s running window would otherwise mislabel "idle".
  const thinkingOnly =
    hasThinkingBlock(content) &&
    !text &&
    !(Array.isArray(content) && content.some((b: any) => b?.type === "tool_use"));
  if (thinkingOnly) return ageMs > THINKING_WINDOW_MS ? "idle" : "thinking";
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
  let latestTodos: any[] | undefined;
  let lastError: { text: string; at: number } | undefined;
  // Tracks whether the most recent tool result (chronologically) was a failure;
  // a later successful tool flips it back, so we only surface "currently red".
  let errorIsLatestTool = false;
  // tool_use id -> tool name, so a failed tool_result can name what failed.
  const toolNameById = new Map<string, string>();

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
    // A tool result comes back as a user-type line carrying tool_result blocks;
    // is_error marks a failure (non-zero Bash exit, tool exception, …). Track
    // the most recent one so we can flag "ended on a failure" with no LLM.
    if (line.type === "user") {
      const rc = line.message?.content;
      if (Array.isArray(rc)) {
        for (const b of rc) {
          if (b?.type !== "tool_result") continue;
          if (b.is_error === true) {
            const tn =
              (typeof b.tool_use_id === "string" && toolNameById.get(b.tool_use_id)) || "Tool";
            lastError = { text: errorReason(tn, b, line.toolUseResult), at: ts || lastActivity };
            errorIsLatestTool = true;
          } else {
            errorIsLatestTool = false;
          }
        }
      }
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
            if (typeof b.id === "string") toolNameById.set(b.id, b.name);
            if (b.name === "TodoWrite" && Array.isArray(b.input?.todos)) latestTodos = b.input.todos;
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
      // A thinking-only turn has no tool and no text. Surface "Thinking…" only
      // when the agent has no prior action yet (a just-started turn) — once it
      // has really done something we keep that, so a meaningful tree/subagent
      // label never flips to a bare "Thinking…" mid-turn. (Subagents have no
      // liveAction to mask it, so this matters.) The live transcript still shows
      // a thinking marker regardless — see readMessages.
      if (!act && !lastAction && hasThinkingBlock(content)) act = "Thinking…";
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

  const plan = planFromTodos(latestTodos);
  const errReason = errorIsLatestTool ? lastError?.text : undefined;

  let status = deriveStatus(lines, lastActivity);
  // If the most recent tool ended in failure and the agent has since gone quiet
  // (no recovery, no further work), surface that as an explicit error — this is
  // the actionable "it stopped on a red test" case. A still-working agent keeps
  // its running/thinking status; we only show the chip (errReason) for that.
  if (
    errReason &&
    lastError &&
    Date.now() - lastError.at < ERROR_WINDOW_MS &&
    (status === "idle" || status === "done" || status === "unknown")
  ) {
    status = "error";
  }

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
    plan,
    lastError: errReason,
  };
}

export interface FlatMessage {
  role: "user" | "assistant" | "tool" | "thinking";
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
    // assistant: emit thinking marker (if any) → text → a line per tool_use.
    // Claude Code splits one assistant message across several JSONL lines (one
    // per content block, shared message.id), so a "thinking phase" arrives as
    // its own line. Surfacing it keeps the detail view live while the agent
    // reasons; recent models persist thinking as signature-only (empty text),
    // so we fall back to a bare "Thinking…" marker.
    if (hasThinkingBlock(content)) {
      out.push({ role: "thinking", text: thinkingText(content), ts });
    }
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
  // A signature-only thinking block (current models persist no plaintext) has
  // empty text. Such a marker is only useful as a *live* "thinking now" hint, so
  // keep one only when it is the final entry — drop earlier empties so history
  // isn't striped with a blank "Thinking…" row before every turn. Thinking
  // blocks that actually carry text are always kept.
  const pruned = out.filter(
    (m, i) => m.text || m.role !== "thinking" || i === out.length - 1,
  );
  return pruned.slice(-limit);
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
