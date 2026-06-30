# Changelog

All notable changes to **Agent View for Claude Code** are documented here.
This project adheres to [Semantic Versioning](https://semver.org/).

## [0.5.0] — 2026-06-30

Three headline features for working with a fleet of agents — **Review & Land**, the
**Teams cockpit**, and **Unattended Fleet** — plus a UI readability pass and a more
inviting Pinboard. Each feature was hardened with an adversarial multi-agent review.

### Changed

- **UI readability pass.** Loud, solid, ALL-CAPS status chips across the Detail panel and
  the Pinboard are now calm, natural-case tinted pills; transcript role labels are tinted
  per role and long tool output is capped + scrollable; the model/token/time meta wraps
  cleanly instead of truncating.
- **A more inviting Pinboard.** A pin icon and an empty-welcome link make it discoverable;
  the empty state leads with the value and a zero-cost tour; the dock self-documents with
  labels; a "Race"/"Fan-out" toast offers to open it; and after a race/fan-out you're
  nudged toward the spatial view. The Teams cockpit gains a switcher when several teams run.

### Added

- **Unattended Fleet (governed auto-pilot).** Toggle it from the Agents toolbar (or
  `Agent View: Toggle Unattended Fleet`). While on, Agent View-spawned agents run with
  guardrails:
  - **Safe auto-accept** — new agents spawn with `--permission-mode acceptEdits`, so file
    edits don't block, but **Bash and other tools still prompt** (which surfaces as
    "needs you" and a notification — a stray destructive command never runs unattended).
  - **Auto-nudge stalled agents** — an agent that goes idle mid-plan is nudged to keep
    going, capped at `mas.unattended.maxNudges`, then escalated to you if it stays stuck.
  - **Cost meter + budget** — Fleet Pulse shows a live estimated `~$X.XX` for the fleet,
    and a per-agent `mas.unattended.maxCostUsd` cap pauses an agent that exceeds it
    (its branch and diff are kept). Prices are configurable (`mas.unattended.pricing`).
- **Teams cockpit (Pinboard).** A new **Teams** mode on the Pinboard (toggle in the
  dock, badged with the teammate count) visualizes an active Agent-Teams-style run,
  live and read-only:
  - **Roster** of named teammates (from each session's subagent sidecars), with a
    `plan` badge for plan-approval teammates, plus live status, type, and tokens —
    click one to focus it.
  - **Task dependency graph** parsed from the lead's shared task list (its TodoWrite):
    a topological-layer DAG with dependency edges, `owner` badges, and a derived
    `blocked` state (waiting on an unfinished dependency).
  - **Workflow runs** (`subagents/workflows/wf_*`) shown as chips.
  - Native-store aware: if Claude Code's experimental Agent Teams store
    (`~/.claude/teams` / `~/.claude/tasks`) ever materializes, the cockpit detects it.
- **Review & Land.** A new **Review** tab (and the `Agent View: Review & Land` toolbar
  button) turns each spawned agent's work into a reviewable, landable unit:
  - **True diffs.** Every changed file opens as a native VS Code side-by-side diff
    against the agent's exact fork point — committed **and** uncommitted **and**
    untracked files (the old diff showed only committed work). Rows show a `+/−` stat,
    the agent's plan `done/total`, and a tests-red / uncommitted chip.
  - **Request changes.** Type feedback and it is sent to the agent's terminal and saved
    to `.agentview/review/<id>.json` (the same no-new-network-surface bridge as the
    Pinboard), so the agent can revise in place.
  - **Land it.** **Squash-merge** into your current branch — refused on a dirty/mid-merge
    tree, snapshots the agent's uncommitted work first so what you reviewed is what lands,
    and is reversible (Undo) until you push. Off by default behind `mas.review.allowLand`;
    **Open PR** (`gh pr create`, with a push-and-copy-compare-link fallback) and **Copy
    merge command** work regardless. Nothing is auto-merged and no branch is ever deleted.
  - New settings: `mas.review.allowLand`, `mas.review.maxDiffFiles`, `mas.review.ghPath`.

## [0.4.2] — 2026-06-29

### Fixed

- README feature list rendering — the embedded Pinboard image had no blank line
  after its `</p>`, so the HTML block swallowed the rest of the list and the
  remaining features collapsed into one paragraph on the Marketplace/Open VSX
  listing. No functional changes.

## [0.4.1] — 2026-06-29

### Changed

- Docs/listing refresh only — no functional changes. The promo GIF is re-rendered
  at a higher resolution (and now includes a Pinboard scene), and a dedicated
  Pinboard GIF was added, so the Marketplace/Open VSX listing shows the sharper,
  current walkthrough.

## [0.4.0] — 2026-06-29

### Added

- **Live plan progress.** When an agent keeps a `TodoWrite` to-do list, its own plan is
  now surfaced as a `4/7 · <current step>` chip in the Agents tree, the Detail view, and
  the Pinboard — the agent's ground-truth "now doing X", parsed from the transcript with
  no extra LLM calls. The ambient action line shows `Plan 4/7 · …` instead of a constant
  "Updating the plan".
- **Failure detection (no LLM).** When an agent's most recent tool ends in failure
  (a non-zero `Bash` exit, a tool error), it surfaces a precise reason
  (`Bash failed: <first stderr line>`) on the tree, the Detail view, and the Attention
  Router, and promotes the agent to the `error` state if it then goes quiet. Read straight
  from the session transcript, so it works for externally-launched agents too.
- **Fleet Pulse.** A one-line status-bar heartbeat (`2 running · 1 needs you · 3 idle`)
  that stays visible even when the Agent View panel is closed, turns the warning color the
  moment any agent needs you, and jumps to that agent on click. Toggle with the new
  `mas.statusBar.enabled` setting.
- **Dismiss "needs you".** A stuck `waiting`/`error` agent can now be manually dismissed —
  inline in the tree, a "Dismiss all" status-bar button, or per-row in the inbox. A
  dismissed agent reads as plain **idle**, and **resurfaces automatically the moment it
  does something new** (or on a fresh hook-driven prompt), so a real ask is never lost.

## [0.3.0] — 2026-06-25

### Added

- **Pinboard — an infinite canvas for your agents.** Open it from the Agents toolbar.
  Every agent is a live card you can arrange on a pan/zoom canvas:
  - **Pin** a diff (for spawned worktree agents) or an external agent's latest output as a
    durable card, saved into `.agentview/board/` so the board is git-committable and travels
    with the branch. Add notes, link cards with labelled arrows (selecting one linked card
    selects the whole connected group), and expand an agent's subagents as tethered cards.
  - **Send a selection back to an agent** — the agent reads `.agentview/board/selection.json`
    and can post results onto the board by writing `.agentview/board/inbox/<id>.json`. No new
    network surface; the bridge is files the extension watches.
  - A **Figma-style floating toolbar** — a bottom-center dock plus a contextual selection bar.
- **A distinct `thinking` status.** A long reasoning phase, or a parent delegating to active
  subagents, now shows **thinking** (instead of flipping to idle) across the tree, the Detail
  view, and the Pinboard; parents show how many subagents are working.
- **Recency window.** A `mas.recentHours` display window (default 24h) hides older idle agents
  behind a one-click "Show older (N)" toggle in the tree and Pinboard. Active agents always
  show; the 7-day discovery bound (`mas.recentDays`) is unchanged. External transcripts are
  only hidden, never deleted.

### Changed

- Removed emoji throughout the UI in favour of clean text and inline icons.

## [0.2.5] — 2026-06-23

### Added

- **The agent's thinking phase is now visible in the Detail transcript.** While an agent
  is reasoning, a live "💭 Thinking…" marker shows at the bottom of the transcript and is
  replaced by its reply or tool call the moment it acts. When a model records its thinking
  text (extended-thinking turns), the thinking is shown inline and dimmed. Most recent
  models persist thinking as signature-only, so those turns show just the live marker —
  previously the view appeared frozen while the agent thought.
- **Agent-consumable repository docs** — `AGENTS.md` (build/verify commands, project
  layout, conventions, gotchas for AI coding agents) and `llms.txt` (an llmstxt.org index
  of the docs and key source files). Both are excluded from the packaged extension.

## [0.2.4] — 2026-06-22

### Fixed

- **Agent titles now summarise the task instead of echoing the first sentence.** Claude
  Code already generates a short, self-updating title for each session, but the extension
  read the wrong transcript field and always fell back to the opening prompt. It now uses
  Claude's native title and keeps it fresh as the conversation's focus shifts. Sessions
  Claude hasn't titled yet still fall back to the first prompt.

### Changed

- Agents you spawn (race / fan-out / New Agent) now adopt Claude's evolving title once it
  exists, rather than staying pinned to the prompt you launched them with. Race contenders
  keep their `Race N ·` prefix so same-prompt agents remain distinguishable.

## [0.2.3] — 2026-06-22

### Changed

- Docs only: the extension is now published on the **VS Code Marketplace** in addition
  to Open VSX, and the Install section reflects that (VS Code users can install directly
  instead of sideloading a `.vsix`). No functional changes — this release exists to
  refresh the README shown on the marketplace listing pages.

## [0.2.2] — 2026-06-22

### Changed

- Removed the redundant `＋` (New Agent) and `⟳` (Refresh) buttons from the Detail
  panel header — they duplicated the Agents toolbar. The Detail/Race/Fan-out tabs,
  which are unique to this panel, stay.

## [0.2.1] — 2026-06-22

### Fixed

- Actually removed the detail-view "NOW" box. 0.2.0 documented this, but the box was
  still rendered (it echoed the agent's last message under a "NOW" label); it is now
  gone from the markup and styles. The live "now doing X" overview remains the intended
  replacement.

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
