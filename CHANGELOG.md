# Changelog

All notable changes to **Agent View for Claude Code** are documented here.
This project adheres to [Semantic Versioning](https://semver.org/).

## [0.2.0] — 2026-06-22

Three headline features for working with a fleet of agents, plus hardening from a
multi-dimension review.

### Added

- **Notifications** — a toast (and optional chime) when an agent needs your input,
  finishes, or hits an error. Subagents are excluded to avoid bursts, and "finished"
  fires at most once per agent so interactive sessions don't ping every turn.
  Configurable: `mas.notifications.enabled` / `.sound` / `.onWaiting` / `.onDone` /
  `.onError`.
- **Ambient "now doing X"** — every agent shows a live one-liner of its current action
  ("Editing auth.ts", "Running: npm test", "Searching: …"), derived from hook tool
  events with no extra LLM calls. Shown in the Agents tree and the detail panel.
- **🏁 Agent Race (best-of-N)** — spawn N agents on the same prompt, each in its own
  worktree, and compare them in a new **Race** tab: live per-contender status/tokens,
  **Open all diffs** (side-by-side columns), an optional **Rank with AI** pass (reuses
  Merge Advisor), and **Pick winner** — which opens the winner's diff and copies its
  `git merge <branch>` command. Nothing is merged or deleted automatically. Commands:
  `Agent View: Race Agents`, `Agent View: Clean Up Race/Fan-out Worktrees`. Config:
  `mas.race.defaultCount`.
- **Fan-out** — paste a checklist into the **Fan-out** tab, or select lines in any file
  and run `Agent View: Fan-out Selection to Agents`, to spawn one worktree-agent per
  task. Capped at `mas.fanout.maxConcurrent` (default 4) so remaining tasks queue and
  start as earlier agents finish. Config: `mas.fanout.maxConcurrent`, `mas.fanout.useWorktree`.

### Changed

- Removed the detail-view "NOW" box that merely echoed the last message; its intent is
  now served by the live "now doing X" overview.
- `lastAction` phrasing is humanized ("Editing X" instead of raw `Edit <path>`) and kept
  brief.
- Worktree diffs now use the exact fork-point commit captured at spawn, so they stay
  correct even if you switch the repo's branch afterwards.

### Fixed

- **Windows**: task prompts were quoted with POSIX single-quote escaping and corrupted
  under PowerShell/cmd; quoting is now platform-aware. Extra spawn flags are quoted too.
- Terminal hook statuses (idle/done/error) could pin a session's status forever; they
  now age out and yield to newer transcript activity.
- The Race tab no longer strands you on an empty surface if its agents are removed
  elsewhere.
- The fan-out draft is no longer lost when switching view tabs.
- Bounded growth of internal status/notification tracking maps; assorted error-handling,
  cleanup-on-failure, and accessibility fixes.

## [0.1.3] — 2026-06-18

- Fix: show the full message in the detail "NOW" box.

## [0.1.2] — 2026-06-18

- Initial release: Agents panel, worktree spawning, live status, React detail view, and
  the opt-in AI helpers (Conflict Radar, Attention Router, Merge Advisor).
