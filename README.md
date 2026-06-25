# Agent View for Claude Code

A VS Code panel to **spawn, orchestrate, and monitor multiple Claude Code agents** — each
running in its own isolated git worktree/branch — without leaving your editor. Runs in
VS Code and VS Code-based IDEs (Antigravity, Cursor, Windsurf, …).

<p align="center">
  <img src="docs/agent-view.gif" alt="Agent View for Claude Code — a live tour of the Agents panel, isolated git worktrees, Agent Race (best-of-N), Fan-out, and notifications" width="820">
</p>

> **Unofficial.** This is a community-built extension. It is **not affiliated with,
> endorsed by, or sponsored by Anthropic**. "Claude" and "Claude Code" are trademarks
> of Anthropic, PBC, used here only to describe interoperability. You need your own
> Claude Code installation and Claude subscription to use it.

> Status: v0.3.0 — discovery, worktree spawning, live status (now with a distinct
> **thinking** state), the React detail view, desktop notifications, ambient "now doing X"
> status, **Agent Race** (best-of-N), **Fan-out**, and a new **Pinboard** — an infinite
> canvas to watch agents, pin diffs, annotate, and hand a selection back. Expect rough
> edges; issues and PRs welcome.

## Install

Published on the **[VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=inthepond.agent-view-for-claude-code)** and **[Open VSX](https://open-vsx.org/extension/inthepond/agent-view-for-claude-code)**.

- **Antigravity, VSCodium, Cursor, Windsurf** (Open VSX is their default registry) —
  search **"Agent View for Claude Code"** in the Extensions view, or from a terminal:
  ```bash
  antigravity --install-extension inthepond.agent-view-for-claude-code
  # same flag for: codium / cursor / windsurf
  ```
- **VS Code (Microsoft build)** — search **"Agent View for Claude Code"** in the
  Extensions view, or from a terminal:
  ```bash
  code --install-extension inthepond.agent-view-for-claude-code
  ```

**Requirements:** [Claude Code](https://claude.com/claude-code) on your `PATH`, and a Claude subscription.

## Why

Claude Code can run many sessions and subagents at once, but there's no native
in-editor way to see them all, know which one needs your input, and steer them.
Agent View gives you one **Agents** panel: a live fleet list + a detail view, plus
one-click spawning of parallel agents in clean worktrees.

## Features

- **Agents panel** — a live tree of every Claude Code session discovered from
  `~/.claude/projects`, showing status (idle / running / thinking / needs-you), model,
  and token/cost, with a React **Detail** view of the transcript. A parent delegating to
  subagents shows **thinking** with a count of its working subagents; older idle agents
  tuck behind a one-click recency toggle (`mas.recentHours`, default 24h).
- **Pinboard (canvas)** — an infinite spatial canvas (open from the Agents toolbar):
  every agent is a live card you can arrange and pan/zoom around. **Pin** a diff (or an
  external agent's latest output) as a durable card saved into `.agentview/board/`
  (git-committable), add notes, link cards with labelled arrows, expand an agent's
  subagents, and **send** a selection back to an agent — which can post results straight
  back onto the board. A Figma-style floating toolbar holds the tools.
- **Spawn in isolated worktrees** — one-click **New Agent** creates a fresh git
  worktree + branch so parallel agents never clobber each other's files.
- **Live status** — Claude Code hooks stream real-time events; transcript replay is
  the zero-config fallback.
- **Ambient "now doing X"** — every agent shows a live one-liner of its current
  action ("Editing auth.ts", "Running: npm test"), derived from hook tool events
  with no extra LLM calls.
- **Notifications** — a toast (and optional chime) when an agent needs your input,
  finishes, or hits an error, so you can walk away and get pinged. Fully configurable
  under `mas.notifications.*`.
- **Agent Race (best-of-N)** — spawn N agents on the *same* prompt, each in its own
  worktree, and compare them side by side in the **Race** tab: live status, "Open all
  diffs", an optional **Rank with AI** pass, and **Pick winner** (opens its diff and
  copies the `git merge` command). Nothing is merged or deleted automatically.
- **Fan-out** — paste a checklist (or select lines in any file) and spawn one
  worktree-agent per task, capped at `mas.fanout.maxConcurrent` so the rest queue.
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
