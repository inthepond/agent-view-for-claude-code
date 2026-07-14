import { useState } from "react";
import type { ReviewQueue } from "./protocol";
import { post } from "./vscodeApi";
import { Dot, fmtTok, relTime } from "./ui";

/** Review & Land: each managed agent's diff, with actions to inspect it, send
 *  changes back to the agent, and land it (squash-merge / PR). */
export function ReviewView({ queue }: { queue: ReviewQueue | null }) {
  const [openComment, setOpenComment] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  if (!queue || queue.items.length === 0) {
    return (
      <div className="empty">
        No agent work to review yet. Spawn one with <b>New Agent</b> (or run a <b>Race</b> / <b>Fan-out</b>);
        once it edits files in its worktree, the diff shows up here to review and land.
      </div>
    );
  }

  const send = (id: string) => {
    const text = (drafts[id] || "").trim();
    if (!text) return;
    post({ type: "requestChanges", sessionId: id, comment: text });
    setDrafts((d) => ({ ...d, [id]: "" }));
    setOpenComment(null);
  };

  return (
    <section className="review">
      <div className="review-head">
        <div className="review-title">Review &amp; Land · {queue.items.length}</div>
        <button className="btn ghost tiny" onClick={() => post({ type: "refreshReview" })}>
          Refresh
        </button>
      </div>

      <div className="review-list">
        {queue.items.map((it) => (
          <div key={it.sessionId} className="review-row">
            <div className="review-row-head">
              <Dot status={it.status} />
              <span className="review-label" title={it.label}>
                {it.label}
              </span>
              {it.groupRole && <span className="badge sub">{it.groupRole}</span>}
            </div>

            <div className="review-meta">
              {it.branch && (
                <span className="review-branch" title={it.branch}>
                  {it.branch.replace(/^mas\//, "")}
                </span>
              )}
              <span className="review-stat" title={`${it.files} changed file${it.files === 1 ? "" : "s"}`}>
                <span className="add">+{it.additions}</span> <span className="del">−{it.deletions}</span>{" "}
                <span className="files">
                  {it.files} file{it.files === 1 ? "" : "s"}
                </span>
              </span>
              <span className="review-tok">
                {fmtTok(it.tokensTotal)} tok · {relTime(it.lastActivity)}
              </span>
            </div>

            <div className="review-chips">
              {it.plan && it.plan.total > 0 && (
                <span className="status-pill plan reason" title={it.plan.current || "plan progress"}>
                  {it.plan.done}/{it.plan.total}
                  {it.plan.current ? " · " + it.plan.current : ""}
                </span>
              )}
              {it.lastError && (
                <span className="status-pill error reason" title={it.lastError}>
                  {it.lastError}
                </span>
              )}
              {it.hasUncommitted && (
                <span
                  className="status-pill waiting reason"
                  title="The agent has changes it hasn't committed — landing snapshots them first so what you reviewed is what lands."
                >
                  uncommitted
                </span>
              )}
              {it.evidence &&
                (() => {
                  // Precedence mirrors the land gate: running > failing > stale.
                  // A red run must stay red even when it is also stale.
                  const e = it.evidence;
                  const pill = e.running
                    ? { cls: "thinking", text: "checks running", title: "Evidence checks are running in the worktree" }
                    : !e.ok
                      ? {
                          cls: "error",
                          text: `checks ${e.passed}/${e.total}`,
                          title: `Evidence checks failed in the worktree${e.stale ? " (and the work changed since)" : ""} — see Show Evidence Report`,
                        }
                      : e.stale
                        ? { cls: "waiting", text: "checks stale", title: "The work changed after the checks ran — re-run evidence for current proof" }
                        : {
                            cls: "running",
                            text: `checks ${e.passed}/${e.total}`,
                            title: `All ${e.total} evidence check${e.total === 1 ? "" : "s"} passed in the worktree`,
                          };
                  return (
                    <span className={`status-pill ${pill.cls} reason`} title={pill.title}>
                      {pill.text}
                    </span>
                  );
                })()}
            </div>

            <div className="review-actions">
              <button
                className="btn tiny"
                disabled={it.files === 0}
                onClick={() => post({ type: "openReviewDiff", sessionId: it.sessionId })}
              >
                Diff
              </button>
              <button className="btn tiny" onClick={() => post({ type: "select", sessionId: it.sessionId })}>
                Transcript
              </button>
              <button
                className="btn tiny"
                onClick={() => setOpenComment(openComment === it.sessionId ? null : it.sessionId)}
              >
                Request changes
              </button>
              {queue.allowLand && (
                <button
                  className="btn tiny pick"
                  disabled={it.files === 0}
                  onClick={() => post({ type: "landAgent", sessionId: it.sessionId })}
                  title="Squash-merge into your current branch (undoable before you push)"
                >
                  Squash-merge
                </button>
              )}
              <button
                className="btn tiny"
                disabled={it.files === 0}
                onClick={() => post({ type: "openPR", sessionId: it.sessionId })}
                title={queue.ghAvailable ? "Push and open a PR with gh" : "Push and copy a PR compare link"}
              >
                Open PR
              </button>
              <button
                className="btn tiny ghost"
                onClick={() => post({ type: "copyMerge", sessionId: it.sessionId })}
              >
                Copy merge
              </button>
              <button
                className="btn tiny ghost"
                onClick={() => post({ type: "cleanupAgent", sessionId: it.sessionId })}
                title="Remove the worktree (keeps the branch)"
              >
                Clean up
              </button>
            </div>

            {openComment === it.sessionId && (
              <div className="review-comment">
                <textarea
                  className="review-comment-box"
                  placeholder="What should the agent change? Sent to its terminal and saved to .agentview/review/…"
                  value={drafts[it.sessionId] || ""}
                  onChange={(e) => setDrafts((d) => ({ ...d, [it.sessionId]: e.target.value }))}
                />
                <div className="review-comment-actions">
                  <button
                    className="btn tiny"
                    disabled={!(drafts[it.sessionId] || "").trim()}
                    onClick={() => send(it.sessionId)}
                  >
                    Send to agent
                  </button>
                  <button className="btn tiny ghost" onClick={() => setOpenComment(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      <p className="review-foot">
        {queue.allowLand
          ? "Squash-merge commits into your current branch (undoable before you push). Nothing is pushed without confirmation."
          : 'Landing is off — enable mas.review.allowLand to squash-merge from here. "Copy merge" and "Open PR" still work.'}
      </p>
    </section>
  );
}
