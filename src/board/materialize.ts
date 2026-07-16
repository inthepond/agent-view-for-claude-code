import {
  EventStrip,
  classifyLine,
  contentToText,
  isHumanPrompt,
  readEventStrip,
  readParsedLines,
  tsOf,
} from "../transcript";

// The Session Board materializer: projects one session transcript into board
// objects using mechanical promotion rules (no LLM). The rules were derived by
// hand-replaying a real 3.5h session (CaaC probe 01):
//   - each human prompt opens an episode (the spine)
//   - numbered list lines in a prompt become requirement chips
//   - TodoWrite snapshots collapse into one living plan object per episode
//   - "[branch hash] subject" tool results become commit milestones
//   - verification media/checks become evidence chips
//   - everything else collapses into per-episode machinery counts, where
//     errors only surface if nothing succeeded after them (self-healed noise)

/** Tools whose input names a file (mirrors transcript.EDIT_TOOLS, which is
 *  intentionally private — the board needs the file path, not just the class). */
const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "str_replace_based_edit_tool"]);

/** Bash calls that read as verification rather than plumbing. */
const EVIDENCE_RE = /(screenshot|record|video|frame|ffmpeg|simctl|playwright|\btest\b|typecheck|lint|vitest|jest|pytest)/i;

/** Git commit confirmation, e.g. "[main abc1234] subject line". */
const COMMIT_RE = /\[([\w./-]+)\s+([0-9a-f]{7,40})\]\s*([^\n]*)/g;

/** A gap this long inside one episode is a stall worth flagging. */
const STALL_MS = 10 * 60_000;

const MAX_REQUIREMENTS = 8;
const MAX_NOTES = 5;
const MAX_EVIDENCE = 6;
const MAX_SHELF = 24;

export interface BoardCommit {
  hash: string;
  subject: string;
  ts: number;
}

export interface BoardPlanItem {
  content: string;
  status: "completed" | "in_progress" | "pending";
}

export interface BoardNote {
  text: string;
  ts: number;
}

export interface BoardMachinery {
  edits: number;
  shell: number;
  reads: number;
  other: number;
  /** Unresolved failures (a later success clears one back into selfHealed). */
  errors: string[];
  selfHealed: number;
  /** Longest silent gap inside the episode, minutes, when over threshold. */
  stallMin?: number;
}

export interface BoardEpisode {
  index: number;
  startTs: number;
  endTs: number;
  /** The human prompt that opened this episode (trimmed for the card). */
  prompt: string;
  promptTs: number;
  /** Numbered-list lines parsed out of the prompt. */
  requirements: string[];
  /** First lines of the model's prose blocks — its own narration/diagnoses. */
  notes: BoardNote[];
  /** How many notes were dropped by the cap (UI shows "+n earlier"). */
  notesDropped: number;
  plan?: { items: BoardPlanItem[]; snapshots: number };
  evidence: string[];
  machinery: BoardMachinery;
  commits: BoardCommit[];
}

export interface SessionBoardData {
  sessionId: string;
  label: string;
  gitBranch?: string;
  startTs: number;
  endTs: number;
  episodes: BoardEpisode[];
  /** Session-wide artifact shelf: files by edit count, descending. */
  shelf: { file: string; edits: number }[];
  shelfDropped: number;
  strip: EventStrip | null;
  totals: {
    events: number;
    toolCalls: number;
    edits: number;
    prompts: number;
    /** Human words across all prompts — the "343 words" number. */
    words: number;
    commits: number;
  };
}

function newMachinery(): BoardMachinery {
  return { edits: 0, shell: 0, reads: 0, other: 0, errors: [], selfHealed: 0 };
}

function newEpisode(index: number, prompt: string, ts: number): BoardEpisode {
  return {
    index,
    startTs: ts,
    endTs: ts,
    prompt,
    promptTs: ts,
    requirements: parseRequirements(prompt),
    notes: [],
    notesDropped: 0,
    evidence: [],
    machinery: newMachinery(),
    commits: [],
  };
}

function parseRequirements(prompt: string): string[] {
  const out: string[] = [];
  for (const line of prompt.split("\n")) {
    const m = /^\s*\d+[.)]\s+(.{3,})/.exec(line);
    if (m) out.push(m[1].replace(/\s+/g, " ").trim().slice(0, 90));
    if (out.length >= MAX_REQUIREMENTS) break;
  }
  return out;
}

/** First line of a prose block, tightened for a note chip. */
function noteText(text: string): string {
  const first = text.split("\n").find((l) => l.trim()) || "";
  return first.replace(/^#+\s*/, "").replace(/\*\*/g, "").replace(/\s+/g, " ").trim().slice(0, 160);
}

function firstLine(text: string): string {
  return (text.split("\n").find((l) => l.trim()) || "").replace(/\s+/g, " ").trim();
}

/** All text carried by a tool_result line (blocks + structured stdout). */
function resultText(line: any): string {
  let text = "";
  const content = line.message?.content;
  if (Array.isArray(content)) {
    for (const b of content) {
      if (b?.type !== "tool_result") continue;
      const c = b.content;
      if (typeof c === "string") text += c + "\n";
      else if (Array.isArray(c)) {
        for (const x of c) if (x && typeof x.text === "string") text += x.text + "\n";
      }
    }
  }
  const stdout = line.toolUseResult?.stdout;
  if (typeof stdout === "string") text += stdout;
  return text;
}

function pushNote(ep: BoardEpisode, text: string, ts: number): void {
  ep.notes.push({ text, ts });
  // Keep the most recent notes — later prose tends to carry outcomes.
  if (ep.notes.length > MAX_NOTES) {
    ep.notes.shift();
    ep.notesDropped++;
  }
}

/** Project one session transcript into Session Board objects. */
export function materializeSession(
  jsonlPath: string,
  meta: { sessionId: string; label: string; gitBranch?: string },
): SessionBoardData | null {
  const lines = readParsedLines(jsonlPath);
  if (lines.length === 0) return null;

  const episodes: BoardEpisode[] = [];
  const fileEdits = new Map<string, number>();
  const toolNameById = new Map<string, string>();
  const totals = { events: 0, toolCalls: 0, edits: 0, prompts: 0, words: 0, commits: 0 };
  let startTs = 0;
  let endTs = 0;
  let prevTs = 0;

  const current = (): BoardEpisode => {
    if (episodes.length === 0) episodes.push(newEpisode(0, "(session start)", prevTs));
    return episodes[episodes.length - 1];
  };

  for (const line of lines) {
    if (line?.type !== "user" && line?.type !== "assistant") continue;
    const ts = tsOf(line);
    if (ts) {
      if (!startTs) startTs = ts;
      if (ts > endTs) endTs = ts;
    }
    totals.events += classifyLine(line).length;

    if (line.type === "user") {
      if (isHumanPrompt(line)) {
        const text = contentToText(line.message?.content).trim();
        totals.prompts++;
        totals.words += text.split(/\s+/).filter(Boolean).length;
        // A new human prompt closes the previous episode and opens the next —
        // unless the board is empty and this is the first prompt.
        if (episodes.length === 1 && episodes[0].prompt === "(session start)" && totals.prompts === 1) {
          const ep = episodes[0];
          ep.prompt = text.slice(0, 400);
          ep.promptTs = ts;
          ep.requirements = parseRequirements(text);
        } else {
          episodes.push(newEpisode(episodes.length, text.slice(0, 400), ts));
        }
      } else {
        const ep = current();
        // Failures: surface only what nothing recovered from.
        const content = line.message?.content;
        if (Array.isArray(content)) {
          for (const b of content) {
            if (b?.type !== "tool_result") continue;
            if (b.is_error === true) {
              const tool =
                (typeof b.tool_use_id === "string" && toolNameById.get(b.tool_use_id)) || "Tool";
              const reason = firstLine(
                typeof b.content === "string"
                  ? b.content
                  : Array.isArray(b.content)
                    ? b.content.map((x: any) => x?.text || "").join(" ")
                    : "",
              )
                .replace(/<\/?tool_use_error>/g, "")
                .slice(0, 100);
              ep.machinery.errors.push(reason ? `${tool}: ${reason}` : `${tool} failed`);
            } else if (ep.machinery.errors.length > 0) {
              ep.machinery.selfHealed += ep.machinery.errors.length;
              ep.machinery.errors = [];
            }
          }
        }
        // Commits confirm through git's "[branch hash] subject" output.
        const text = resultText(line);
        if (text.includes("[")) {
          COMMIT_RE.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = COMMIT_RE.exec(text)) !== null) {
            const commit: BoardCommit = { hash: m[2].slice(0, 7), subject: m[3].trim().slice(0, 90), ts };
            const prev = ep.commits[ep.commits.length - 1];
            // An --amend re-confirms the same subject with a new hash — keep the final one.
            if (prev && prev.subject === commit.subject) ep.commits[ep.commits.length - 1] = commit;
            else ep.commits.push(commit);
          }
        }
      }
    } else {
      const ep = current();
      const content = line.message?.content;
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b?.type === "text" && typeof b.text === "string" && b.text.trim().length >= 60) {
            pushNote(ep, noteText(b.text), ts);
          } else if (b?.type === "tool_use") {
            totals.toolCalls++;
            if (typeof b.id === "string") toolNameById.set(b.id, b.name);
            const input = b.input || {};
            if (b.name === "TodoWrite" && Array.isArray(input.todos)) {
              const items: BoardPlanItem[] = input.todos
                .filter((t: any) => typeof t?.content === "string")
                .map((t: any) => ({
                  content: t.content.replace(/\s+/g, " ").slice(0, 90),
                  status:
                    t.status === "completed" || t.status === "in_progress" ? t.status : "pending",
                }));
              ep.plan = { items, snapshots: (ep.plan?.snapshots || 0) + 1 };
            } else if (FILE_TOOLS.has(b.name)) {
              totals.edits++;
              ep.machinery.edits++;
              const f = input.file_path || input.path || input.notebook_path;
              if (typeof f === "string") fileEdits.set(f, (fileEdits.get(f) || 0) + 1);
            } else if (b.name === "Bash") {
              ep.machinery.shell++;
              const hint = [input.description, input.command].find(
                (s: unknown): s is string => typeof s === "string" && s.length > 0,
              );
              if (hint && EVIDENCE_RE.test(hint) && ep.evidence.length < MAX_EVIDENCE) {
                ep.evidence.push(firstLine(hint).slice(0, 60));
              }
            } else if (b.name === "Read") {
              ep.machinery.reads++;
            } else {
              ep.machinery.other++;
            }
          }
        }
      }
    }

    // Stall detection: the longest silent stretch inside the current episode.
    const ep = episodes[episodes.length - 1];
    if (ep && ts && prevTs && ts - prevTs > STALL_MS && prevTs >= ep.startTs) {
      const min = Math.round((ts - prevTs) / 60_000);
      if (!ep.machinery.stallMin || min > ep.machinery.stallMin) ep.machinery.stallMin = min;
    }
    if (ts) {
      if (ep && !ep.startTs) ep.startTs = ts;
      if (ep && ts > ep.endTs) ep.endTs = ts;
      prevTs = ts;
    }
  }

  if (episodes.length === 0) return null;
  // Counted from the deduped lists — the raw regex also matches amend/pull echoes.
  totals.commits = episodes.reduce((s, e) => s + e.commits.length, 0);

  // Strip the workspace prefix so the shelf reads as project-relative paths.
  const shelfAll = [...fileEdits.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([file, edits]) => ({ file: file.split("/").slice(-3).join("/"), edits }));

  return {
    sessionId: meta.sessionId,
    label: meta.label,
    gitBranch: meta.gitBranch,
    startTs,
    endTs,
    episodes,
    shelf: shelfAll.slice(0, MAX_SHELF),
    shelfDropped: Math.max(0, shelfAll.length - MAX_SHELF),
    strip: readEventStrip(jsonlPath),
    totals,
  };
}
