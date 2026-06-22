/**
 * Parse a pasted checklist / task list into individual task strings.
 *
 * Tolerant of the common shapes people paste: markdown checkboxes (`- [ ] task`,
 * `- [x] task`), bullets (`-`, `*`, `•`), numbered lists (`1.`, `1)`), and plain
 * one-task-per-line text. Markdown headings (`#`), horizontal rules, blank lines,
 * and fenced-code markers are skipped.
 */
export function parseChecklist(text: string): string[] {
  if (!text) return [];
  const tasks: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line) continue;
    if (/^#{1,6}\s/.test(line)) continue; // heading
    if (/^(-{3,}|\*{3,}|_{3,}|```)/.test(line)) continue; // hr / code fence
    // Strip a leading list marker (checkbox, bullet, or number).
    line = line.replace(/^[-*•]\s+\[[ xX]\]\s+/, ""); // - [ ] / - [x]
    line = line.replace(/^[-*•]\s+/, ""); // bullet
    line = line.replace(/^\d+[.)]\s+/, ""); // 1. / 1)
    line = line.trim();
    if (!line || seen.has(line)) continue; // skip blanks + duplicate tasks
    seen.add(line);
    tasks.push(line);
  }
  return tasks;
}
