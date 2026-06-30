import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";

function atomicWrite(file: string, data: string): void {
  const tmp = `${file}.${randomUUID().slice(0, 8)}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

export interface ReviewComment {
  type: "review-comment";
  sessionId: string;
  branch?: string;
  comment: string;
  at: number;
}

/**
 * Bridges reviewer feedback to a running agent via a repo file it can read —
 * the same no-new-network-surface pattern as the Pinboard board bridge. The
 * extension writes `.agentview/review/<sessionId>.json`; the agent is asked
 * (over its terminal) to read it and revise.
 */
export class ReviewStore {
  readonly dir: string;

  constructor(repoRootOrCwd: string) {
    this.dir = path.join(repoRootOrCwd, ".agentview", "review");
  }

  ensure(): void {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  /** Returns the repo-relative path the agent should read. */
  writeComment(sessionId: string, comment: string, branch?: string): string {
    this.ensure();
    const payload: ReviewComment = {
      type: "review-comment",
      sessionId,
      branch,
      comment,
      at: Date.now(),
    };
    atomicWrite(path.join(this.dir, `${sessionId}.json`), JSON.stringify(payload, null, 2));
    return path.join(".agentview", "review", `${sessionId}.json`);
  }
}
