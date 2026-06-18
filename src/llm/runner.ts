import { spawn } from "child_process";

export interface LlmOptions {
  claudePath: string;
  model: string;
  cwd?: string;
  timeoutMs?: number;
}

/**
 * Run Claude Code headlessly (`claude -p --output-format json`) with the prompt
 * piped on stdin (avoids arg-length limits). Returns the model's final text.
 *
 * NOTE: this consumes the user's Claude subscription usage — callers must gate
 * it behind explicit consent (see features/consent.ts).
 */
export function runClaude(prompt: string, opts: LlmOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      opts.claudePath,
      ["-p", "--output-format", "json", "--model", opts.model],
      { cwd: opts.cwd },
    );

    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("claude timed out"));
    }, opts.timeoutMs ?? 120_000);

    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(err.trim() || `claude exited with code ${code}`));
        return;
      }
      try {
        const json = JSON.parse(out);
        resolve(typeof json.result === "string" ? json.result : out);
      } catch {
        resolve(out); // not JSON-wrapped; return raw
      }
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/** Best-effort extraction of a JSON value from a model response (handles ``` fences / prose). */
export function extractJson<T>(text: string): T | null {
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const candidates = [stripped, text];
  const match = text.match(/[[{][\s\S]*[\]}]/);
  if (match) candidates.push(match[0]);
  for (const c of candidates) {
    try {
      return JSON.parse(c) as T;
    } catch {
      /* try next */
    }
  }
  return null;
}
