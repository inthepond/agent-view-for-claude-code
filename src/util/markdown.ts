/**
 * Flatten markdown into clean single-line plain text. Used for one-line summary
 * fields (agent label, current-activity "NOW" line, router reasons) that are
 * shown in places that don't render markdown — the native tree and compact
 * webview status lines — so `**bold**`, `` `code` ``, and `[links](…)` don't
 * leak their syntax. (Full transcript bodies are rendered as real markdown
 * elsewhere; this is only for the terse summaries.)
 */
export function stripMarkdown(input: string): string {
  return input
    .replace(/```[\s\S]*?```/g, " ") // fenced code
    .replace(/`([^`]+)`/g, "$1") // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "") // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links → label
    .replace(/\*\*([^*]+)\*\*/g, "$1") // **bold**
    .replace(/__([^_]+)__/g, "$1") // __bold__
    .replace(/\*([^*]+)\*/g, "$1") // *italic* (underscores left alone to spare file_paths)
    .replace(/~~([^~]+)~~/g, "$1") // ~~strike~~
    .replace(/^\s{0,3}#{1,6}\s+/gm, "") // # headings
    .replace(/^\s{0,3}>\s?/gm, "") // > blockquote
    .replace(/\s+/g, " ")
    .trim();
}
