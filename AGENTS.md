# AGENTS.md

Operational guide for AI coding agents working in this repository. Human-facing
overview, features, and screenshots live in [README.md](README.md); this file is the
"how to work here" companion. Keep both accurate when you change behavior.

## What this is

A VS Code extension — **Agent View for Claude Code** — that discovers, spawns,
orchestrates, and monitors multiple Claude Code agents (each in its own git worktree)
from one panel. It is **two packages in one repo**:

- **Extension host** — `src/**` (TypeScript), bundled by **esbuild** → `dist/extension.js`.
  Runs in Node inside VS Code; `vscode` is an external provided by the runtime.
- **Webview UI** — `webview-ui/**` (React + **Vite**) → `webview-ui/dist/`. Runs in the
  Detail panel's sandboxed webview. It has **no access to `vscode`** — it talks to the
  host only through `postMessage` (see the protocol files below).

## Setup & commands

```bash
npm install                  # root deps (host: @types/node, @types/vscode, esbuild, typescript)
npm run build                # FULL build: webview (Vite) THEN extension host (esbuild)
npm run watch                # esbuild watch — iterate on the host only
npm run typecheck            # host:    tsc --noEmit   (uses ./tsconfig.json, src only)
cd webview-ui && npm run typecheck   # webview: tsc --noEmit (strict, noUnusedLocals)
cd webview-ui && npm run build       # webview only (Vite)
cd webview-ui && npm run dev         # Vite dev server (rarely needed; F5 is the usual loop)
```

- `npm run build:webview` runs `npm install` inside `webview-ui/` first, so the webview has
  its own `node_modules`. After a fresh clone, run the full `npm run build` once.
- To run the extension: open the repo in VS Code and press **F5** (Extension Development
  Host). The Detail panel renders a placeholder until `webview-ui/dist/` exists, so
  **build the webview before launching**.

### Verifying a change (do this before claiming done)

There is **no automated unit-test suite**. The verification gates are:

1. `npm run typecheck` (host) — must be clean.
2. `cd webview-ui && npm run typecheck` — must be clean.
3. `npm run build` — must succeed (this is also `vscode:prepublish`).

`scripts/smoke.ts` is a *manual* data-layer sanity check (discovers your real sessions and
prints a few transcript messages). Note its header one-liner
(`esbuild --bundle … scripts/smoke.ts | node`) currently **fails standalone**, because
`src/util/format.ts` imports `vscode` and it gets pulled transitively. If you must run it,
alias `vscode` to a stub during bundling. Prefer the typecheck + build gates above.

## Where things live

```
src/                       extension host
  extension.ts             activation; wires commands, tree, webview, hooks
  store.ts                 AgentStore: discovers + fs.watch(~/.claude/projects),
                           heartbeat refresh, onDidChange; holds live hook status + liveAction
  discovery.ts             find Claude Code sessions on disk
  transcript.ts            parse session JSONL -> status/tokens/label/lastAction;
                           readMessages() flattens to displayable transcript messages
  subagents.ts             discover child subagents of a session
  types.ts                 shared domain types (AgentSession, AgentStatus, TokenUsage)
  paths.ts                 ~/.claude path helpers
  tree/agentsProvider.ts   native TreeDataProvider for the Agents view (mas.agents)
  webview/provider.ts      DetailViewProvider — host side of the Detail webview (mas.detail)
  webview/protocol.ts      host<->webview message types  (SEE "manual sync" below)
  hooks/server.ts          local HTTP server receiving Claude Code hook events (push status)
  hooks/installer.ts       install/remove hooks in ~/.claude/settings.json
  orchestrator/            worktree.ts, spawn.ts, groups.ts, registry.ts, terminals.ts
                           — spawn managed agents in git worktrees; Agent Race; Fan-out
  features/                router.ts (Attention Router), mergeAdvisor.ts, conflicts.ts
                           (Conflict Radar), notifications.ts, insights.ts, consent.ts
  llm/runner.ts            invoke `claude -p` for the opt-in AI helpers
  util/                    markdown.ts (stripMarkdown), format.ts (humanizeTool, statusIcon),
                           checklist.ts
webview-ui/src/            React Detail UI
  App.tsx                  Detail panel: fleet header, transcript, "Needs you" inbox
  RaceView.tsx             Agent Race tab        FanoutView.tsx  Fan-out tab
  protocol.ts              message types  (MIRROR of src/webview/protocol.ts)
  ui.tsx                   shared presentational helpers   vscodeApi.ts  postMessage bridge
```

### Data sources (fidelity order)

1. **Claude Code hooks** (push, low-latency) — POST to `hooks/server.ts`. When present,
   status is authoritative (`statusSource: "hook"` beats `"jsonl"`).
2. **Session JSONL transcripts** (pull/replay, zero-config fallback) —
   `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`, plus
   `<session-id>/subagents/**/agent-*.jsonl`.

## Conventions you must follow

- **Two `protocol.ts` files are kept in MANUAL sync** — `src/webview/protocol.ts` (host)
  and `webview-ui/src/protocol.ts` (webview). They live under separate tsconfig roots, so
  there is no shared import. **Any change to a message shape (`ExtToWeb` / `WebToExt` /
  `TranscriptMessage` / `AgentSummary` / …) must be edited in BOTH files**, or the panel
  silently breaks at runtime.
- **`vscode` is host-only and external.** Never import it from `webview-ui/**`, and avoid
  pulling it into modules you want to run outside the host. The webview communicates only
  via `postMessage` through `vscodeApi.ts`.
- **Transcript shape gotcha:** Claude Code writes one assistant message as *multiple JSONL
  lines, one per content block*, all sharing `message.id` (order: `thinking` → `text` →
  `tool_use`). Recent models persist thinking as signature-only (empty `thinking` text).
  Parsing code must not assume one line == one turn. See `src/transcript.ts`.
- **Namespacing:** the activity-bar container, all commands, and all settings use the
  `mas` / `mas.*` prefix (e.g. `mas.agents`, `mas.detail`, `mas.newAgent`,
  `mas.notifications.enabled`). Register new commands/settings in `package.json`
  `contributes` and wire them in `extension.ts`.
- **Webview HTML uses a strict CSP with a per-load nonce** (`webview/provider.ts`). Don't
  add inline scripts or external resource loads that the CSP would block.
- **Style:** TypeScript `strict`, 2-space indent, named exports, double quotes. Add a terse
  "why" JSDoc above exported symbols; prefer explaining intent over restating code. Match
  the surrounding file.

## Safety / things that touch the user's machine

- The **orchestrator** spawns real `claude` processes, creates **git worktrees + branches**,
  and opens terminals. Spawn/stop/cleanup operations mutate the user's filesystem and git
  state — read the surrounding code and be conservative. Race/Fan-out never auto-merge or
  auto-delete; keep it that way.
- The **AI helpers** (Attention Router, Merge Advisor, Conflict Radar) are **off by default
  and consent-gated**, and call `claude -p` (consumes the user's Claude subscription). Keep
  them opt-in.

## Commits, PRs, releases

- Branch off and PR against **`main`**.
- Commit style observed in history: a conventional-ish prefix — `docs: …`, `Fix: …`, and
  for releases `Release vX.Y.Z: <one-line summary>`.
- **Release flow:** bump `version` in `package.json`, add a `CHANGELOG.md` entry,
  `npm run build`, then package/publish. Open VSX is the primary registry; the VS Code
  Marketplace listing is updated manually. Don't commit tokens.
