import * as fs from "fs";
import { settingsPath } from "../paths";
import { HOOK_PATH } from "./server";

/** Unique token used to find/remove only MAS-owned hooks. */
const MARKER = HOOK_PATH; // "/mas-hook" appears in our command string

const TOOL_EVENTS = ["PreToolUse", "PostToolUse", "PostToolUseFailure"];
const PLAIN_EVENTS = [
  "UserPromptSubmit",
  "Notification",
  "Stop",
  "SubagentStop",
  "SessionStart",
  "SessionEnd",
];

interface HookEntry {
  type: "command";
  command: string;
}
interface HookGroup {
  matcher?: string;
  hooks: HookEntry[];
}

function buildCommand(port: number): string {
  // Reads the hook event JSON on stdin and POSTs it to the MAS hook server.
  return (
    `curl -sS -m 2 -X POST -H 'content-type: application/json' ` +
    `--data-binary @- http://127.0.0.1:${port}${HOOK_PATH} >/dev/null 2>&1 || true`
  );
}

function readSettings(): Record<string, any> {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
  } catch (e: any) {
    if (e?.code === "ENOENT") return {};
    throw new Error(`Could not parse ${settingsPath()}: ${e.message}`);
  }
}

function isMasGroup(g: HookGroup): boolean {
  return (g.hooks || []).some((h) => typeof h.command === "string" && h.command.includes(MARKER));
}

function stripMas(groups: HookGroup[] | undefined): HookGroup[] {
  return (groups || []).filter((g) => !isMasGroup(g));
}

/** Idempotently install MAS hooks for the given port. Returns the settings path. */
export function installHooks(port: number): string {
  const settings = readSettings();
  const hooks: Record<string, HookGroup[]> = settings.hooks || {};
  const command = buildCommand(port);

  for (const event of TOOL_EVENTS) {
    hooks[event] = stripMas(hooks[event]);
    hooks[event].push({ matcher: "*", hooks: [{ type: "command", command }] });
  }
  for (const event of PLAIN_EVENTS) {
    hooks[event] = stripMas(hooks[event]);
    hooks[event].push({ hooks: [{ type: "command", command }] });
  }

  settings.hooks = hooks;
  writeSettings(settings);
  return settingsPath();
}

/** Remove only MAS-owned hooks, leaving the user's own hooks intact. */
export function removeHooks(): string {
  const settings = readSettings();
  const hooks: Record<string, HookGroup[]> = settings.hooks || {};
  for (const event of Object.keys(hooks)) {
    const cleaned = stripMas(hooks[event]);
    if (cleaned.length === 0) delete hooks[event];
    else hooks[event] = cleaned;
  }
  if (Object.keys(hooks).length === 0) delete settings.hooks;
  else settings.hooks = hooks;
  writeSettings(settings);
  return settingsPath();
}

export function hooksInstalled(): boolean {
  const hooks: Record<string, HookGroup[]> = readSettings().hooks || {};
  return Object.values(hooks).some((groups) => (groups || []).some(isMasGroup));
}

function writeSettings(settings: Record<string, any>): void {
  const p = settingsPath();
  // Safety: back up the user's settings before the first mutation.
  try {
    if (fs.existsSync(p) && !fs.existsSync(p + ".mas-backup")) {
      fs.copyFileSync(p, p + ".mas-backup");
    }
  } catch {
    /* best effort */
  }
  fs.writeFileSync(p, JSON.stringify(settings, null, 2) + "\n", "utf8");
}
