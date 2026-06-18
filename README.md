# Agent View for Claude Code

A VS Code panel to **spawn, orchestrate, and monitor multiple Claude Code agents** — each
running in its own isolated git worktree/branch — without leaving your editor. Runs in
VS Code and VS Code-based IDEs (Antigravity, Cursor, Windsurf, …).

> **Unofficial.** This is a community-built extension. It is **not affiliated with,
> endorsed by, or sponsored by Anthropic**. "Claude" and "Claude Code" are trademarks
> of Anthropic, PBC, used here only to describe interoperability. You need your own
> Claude Code installation and Claude subscription to use it.

> Status: early (v0.1.2) but functional — discovery, worktree spawning, live status,
> and the React detail view work today. Expect rough edges; issues and PRs welcome.

## Install

Published on **[Open VSX](https://open-vsx.org/extension/inthepond/agent-view-for-claude-code)**.

- **Antigravity, VSCodium, Cursor, Windsurf** (Open VSX is their default registry) —
  search **"Agent View for Claude Code"** in the Extensions view, or from a terminal:
  ```bash
  antigravity --install-extension inthepond.agent-view-for-claude-code
  # same flag for: codium / cursor / windsurf
  ```
- **VS Code (Microsoft build)** defaults to the Microsoft Marketplace, where this isn't
  published. Download the `.vsix` from the
  [Open VSX page](https://open-vsx.org/extension/inthepond/agent-view-for-claude-code)
  and install it:
  ```bash
  code --install-extension agent-view-for-claude-code-*.vsix
  ```

**Requirements:** [Claude Code](https://claude.com/claude-code) on your `PATH`, and a Claude subscription.

## Why

Claude Code can run many sessions and subagents at once, but there's no native
in-editor way to see them all, know which one needs your input, and steer them.
Agent View gives you one **Agents** panel: a live fleet list + a detail view, plus
one-click spawning of parallel agents in clean worktrees.

## Features

- **Agents panel** — a live tree of every Claude Code session discovered from
  `~/.claude/projects`, showing status (idle / running / needs-you), model, and
  token/cost, with a React **Detail** view of the transcript.
- **Spawn in isolated worktrees** — one-click **New Agent** creates a fresh git
  worktree + branch so parallel agents never clobber each other's files.
- **Live status** — Claude Code hooks stream real-time events; transcript replay is
  the zero-config fallback.
- **Per-agent actions** — open diff, focus terminal, or stop a managed agent inline.
- **Opt-in AI helpers** (off by default, consent-gated before first run):
  - **Conflict Radar** — local-only; flags files edited by more than one agent.
  - **Attention Router** — triages which agent needs you into a "Needs you" inbox.
    Runs `claude -p` and uses your Claude subscription.
  - **Merge Advisor** — ranks multiple agents' diffs and recommends which to merge.
    Uses your Claude subscription.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ VS Code extension host (TypeScript, esbuild → dist/)         │
│                                                              │
│  data layer            orchestration         live status     │
│  ───────────           ─────────────         ───────────     │
│  discovery.ts          worktree.ts           hooks/server.ts │
│  transcript.ts         spawn.ts              (HTTP, push)    │
│  subagents.ts          registry.ts           hooks/installer │
│  store.ts (fs.watch)   terminals.ts                          │
│        │                                                     │
│        ├──► AgentsProvider (native TreeView: mas.agents)     │
│        └──► WebviewProvider (React detail: mas.detail) ◄───┐ │
└───────────────────────────────────────────────────────────┼─┘
                                                webview-ui/ (React + Vite)
```

Opt-in AI layer (off by default): `src/features/{router,mergeAdvisor,conflicts}` plus
`src/llm/runner.ts` power the "Needs you" inbox, Merge Advisor, and Conflict Radar.

### Data sources (fidelity order)
1. **Claude Code hooks** (push, low-latency) — installed into `~/.claude/settings.json`,
   POST events to the local hook server. Drives real-time status.
2. **Session JSONL transcripts** (pull/replay, zero-config) —
   `~/.claude/projects/<enc-cwd>/<session-id>.jsonl` plus
   `<session-id>/subagents/**/agent-*.jsonl`. Source of truth + fallback.

For agents the extension spawns, we pass `claude --session-id <uuid>` so each agent maps
deterministically to its transcript file.

## Develop

```bash
npm install
npm run build        # builds the React webview (Vite) + the extension (esbuild)
# then press F5 in VS Code to launch the Extension Development Host
```

Or iterate on just the extension host:

```bash
npm run watch        # esbuild watch
npm run typecheck    # tsc --noEmit
```

## Contributing

Issues and pull requests are welcome — this is an unofficial community project.
Build from source (above), then open a PR against `main`.

## License

Apache-2.0 — see [LICENSE](LICENSE). Adapted OSS components are credited in [NOTICE](NOTICE).
