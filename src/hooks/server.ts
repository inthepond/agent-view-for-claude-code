import * as http from "http";
import { AgentStatus } from "../types";

export const HOOK_PATH = "/mas-hook";

/** Map a Claude Code hook event to an agent status. */
export function mapHookEvent(event: any): AgentStatus | undefined {
  const name: string = event?.hook_event_name || event?.hookEventName || "";
  switch (name) {
    case "UserPromptSubmit":
    case "PreToolUse":
    case "PostToolUse":
    case "SessionStart":
    case "SubagentStart":
      return "running";
    case "Notification": {
      const t: string = event?.notification_type || "";
      // permission / idle prompts mean the agent is blocked on the user
      if (t.includes("permission") || t.includes("idle") || t === "") return "waiting";
      return "running";
    }
    case "PostToolUseFailure":
      return "error";
    case "Stop":
    case "SubagentStop":
      return "idle";
    case "SessionEnd":
      return "done";
    default:
      return undefined;
  }
}

export interface HookSink {
  applyHookStatus(sessionId: string, status: AgentStatus): void;
}

/**
 * Lightweight HTTP server that receives Claude Code hook events (POSTed by the
 * installed hook command) and forwards status to the store. Binds to loopback
 * only.
 */
export class HookServer {
  private server?: http.Server;

  constructor(
    private readonly sink: HookSink,
    private readonly onEvent?: (event: any) => void,
  ) {}

  start(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handle(req, res));
      this.server.on("error", reject);
      this.server.listen(port, "127.0.0.1", () => resolve());
    });
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method !== "POST" || !req.url?.startsWith(HOOK_PATH)) {
      res.writeHead(404);
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 5 * 1024 * 1024) {
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      res.writeHead(200);
      res.end("ok");
      try {
        const event = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const sessionId = event?.session_id || event?.sessionId;
        const status = mapHookEvent(event);
        if (sessionId && status) this.sink.applyHookStatus(sessionId, status);
        this.onEvent?.(event);
      } catch {
        /* ignore malformed events */
      }
    });
  }

  dispose(): void {
    this.server?.close();
    this.server = undefined;
  }
}
