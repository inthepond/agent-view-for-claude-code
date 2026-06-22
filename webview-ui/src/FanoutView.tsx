import { useMemo } from "react";
import { post } from "./vscodeApi";

/** Mirror of src/util/checklist.ts for a live in-panel preview. The extension
 *  re-parses authoritatively on spawn; this is only for the count + list. */
function parsePreview(text: string): string[] {
  if (!text) return [];
  const tasks: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line) continue;
    if (/^#{1,6}\s/.test(line)) continue;
    if (/^(-{3,}|\*{3,}|_{3,}|```)/.test(line)) continue;
    line = line.replace(/^[-*•]\s+\[[ xX]\]\s+/, "");
    line = line.replace(/^[-*•]\s+/, "");
    line = line.replace(/^\d+[.)]\s+/, "");
    line = line.trim();
    if (line) tasks.push(line);
  }
  return tasks;
}

export function FanoutView({ text, onChange }: { text: string; onChange: (v: string) => void }) {
  const tasks = useMemo(() => parsePreview(text), [text]);

  return (
    <section className="fanout">
      <div className="fanout-head" id="fanout-head">Fan-out · one agent per task</div>
      <p className="fanout-hint" id="fanout-hint">
        Paste a checklist or list — one task per line. Markdown checkboxes, bullets, and numbers are stripped.
        Each task spawns its own agent in an isolated worktree.
      </p>
      <textarea
        className="fanout-input"
        value={text}
        onChange={(e) => onChange(e.target.value)}
        rows={8}
        spellCheck={false}
        aria-label="Checklist of tasks, one per line"
        aria-describedby="fanout-hint"
        placeholder={"- [ ] Refactor the auth module\n- [ ] Add tests for the parser\n- [ ] Update the README"}
      />
      <div className="fanout-foot">
        <span className="fanout-count">
          {tasks.length} task{tasks.length === 1 ? "" : "s"}
        </span>
        <button className="btn" disabled={tasks.length === 0} onClick={() => post({ type: "fanOut", text })}>
          Spawn {tasks.length || ""} agent{tasks.length === 1 ? "" : "s"}
        </button>
      </div>
      {tasks.length > 0 && (
        <ul className="fanout-preview">
          {tasks.slice(0, 12).map((t, i) => (
            <li key={i} title={t}>
              {t}
            </li>
          ))}
          {tasks.length > 12 && <li className="more">+{tasks.length - 12} more…</li>}
        </ul>
      )}
    </section>
  );
}
