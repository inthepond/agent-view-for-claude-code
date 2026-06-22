import * as vscode from "vscode";
import { AgentStore } from "./store";
import { Registry, ManagedAgent } from "./orchestrator/registry";
import { spawnAgent, SpawnConfig } from "./orchestrator/spawn";
import { spawnRace, FanoutBatch, cleanupGroup } from "./orchestrator/groups";
import { terminals } from "./orchestrator/terminals";
import { worktreeDiff, currentRef, isGitRepo } from "./orchestrator/worktree";
import { AgentsProvider } from "./tree/agentsProvider";
import { DetailViewProvider, WebviewHandlers } from "./webview/provider";
import { RaceGroup, RaceCandidate } from "./webview/protocol";
import { HookServer } from "./hooks/server";
import { installHooks, removeHooks, hooksInstalled } from "./hooks/installer";
import { InsightsController } from "./features/insights";
import { requireLlmConsent } from "./features/consent";
import { runMergeAdvisor } from "./features/mergeAdvisor";
import { NotificationController } from "./features/notifications";
import { parseChecklist } from "./util/checklist";
import { humanizeTool, truncate } from "./util/format";
import { AgentSession } from "./types";

function cfg() {
  return vscode.workspace.getConfiguration("mas");
}

function spawnConfig(): SpawnConfig {
  const c = cfg();
  return {
    claudePath: c.get<string>("claudePath", "claude"),
    defaultModel: c.get<string>("defaultModel", ""),
    worktreeRoot: c.get<string>("worktreeRoot", ".mas/worktrees"),
    spawnExtraFlags: c.get<string[]>("spawnExtraFlags", []),
  };
}

function defaultCwd(): string | undefined {
  return (
    (vscode.window.activeTextEditor &&
      vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri)?.uri.fsPath) ||
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  );
}

function sessionIdOf(arg: AgentSession | string | undefined): string | undefined {
  if (!arg) return undefined;
  return typeof arg === "string" ? arg : arg.sessionId;
}

export function activate(context: vscode.ExtensionContext): void {
  const registry = new Registry(context.globalState);
  const store = new AgentStore(registry, () => ({
    recentDays: cfg().get<number>("recentDays", 7),
  }));

  // Race state held by the host (the webview renders it; the store drives live
  // status/tokens, these maps add the human-only bits).
  const raceScores = new Map<string, { score: number; recommended: boolean }>();
  const raceWinner = new Map<string, string>(); // groupId -> winning sessionId
  const activeBatches = new Set<FanoutBatch>();

  // --- New-agent flow (shared by command + webview button) ---
  async function runNewAgent(): Promise<void> {
    const cwd = defaultCwd();
    if (!cwd) {
      vscode.window.showErrorMessage("Agent View: open a folder/workspace first.");
      return;
    }
    const task = await vscode.window.showInputBox({
      title: "New Claude Code Agent",
      prompt: "Initial task for the agent (leave empty to start an interactive session)",
      placeHolder: "e.g. Refactor the auth module and add tests",
    });
    if (task === undefined) return; // cancelled

    const wtPick = await vscode.window.showQuickPick(
      [
        { label: "$(git-branch) Isolated worktree", description: "new branch, conflict-free", val: true },
        { label: "$(folder) Current directory", description: "run in place", val: false },
      ],
      { title: "Where should the agent run?" },
    );
    if (!wtPick) return;

    try {
      const res = await spawnAgent(
        { cwd, task: task || undefined, useWorktree: wtPick.val },
        registry,
        spawnConfig(),
      );
      vscode.window.showInformationMessage(
        `Agent View: spawned agent on ${res.branch}${wtPick.val ? ` (${res.worktreePath})` : ""}`,
      );
      setTimeout(() => store.refresh(), 800);
    } catch (e: any) {
      vscode.window.showErrorMessage(`Agent View: failed to spawn agent — ${e.message}`);
    }
  }

  // --- Diff helper (shared by command, notification button, race view) ---
  async function openDiffFor(id: string, column?: vscode.ViewColumn): Promise<void> {
    const managed = registry.get(id);
    if (!managed?.worktreePath) {
      vscode.window.showWarningMessage("Agent View: diff is only available for managed worktree agents.");
      return;
    }
    // The recorded fork point gives a stable diff even if the repo's branch
    // moved since spawn; fall back to the current ref for older entries.
    const base = managed.baseRef || (await currentRef(managed.repoRoot));
    const diff = await worktreeDiff(managed.worktreePath, base);
    const doc = await vscode.workspace.openTextDocument({
      content: diff || "(no changes yet)",
      language: "diff",
    });
    await vscode.window.showTextDocument(doc, { preview: true, viewColumn: column });
  }

  // --- Agent Race orchestration ---
  function buildRace(groupId: string): RaceGroup | null {
    const members = registry.byGroup(groupId);
    if (members.length === 0) return null;
    const task = members.find((m) => m.task)?.task || "";
    const candidates: RaceCandidate[] = members
      .slice()
      .sort((a, b) => a.branch.localeCompare(b.branch))
      .map((m, i): RaceCandidate => {
        const a = store.getById(m.sessionId);
        const sc = raceScores.get(m.sessionId);
        const t = a?.tokens;
        return {
          sessionId: m.sessionId,
          index: i,
          label: a?.label || m.label,
          status: a?.status || "unknown",
          tokensTotal: t ? t.input + t.output + t.cacheRead + t.cacheCreate : 0,
          branch: m.branch,
          liveAction: a?.liveAction,
          lastAction: a?.lastAction,
          score: sc?.score,
          recommended: sc?.recommended,
        };
      });
    return {
      groupId,
      task,
      candidates,
      winnerId: raceWinner.get(groupId),
      ranked: candidates.some((c) => typeof c.score === "number"),
    };
  }

  async function pickWinner(sessionId: string): Promise<void> {
    const m = registry.get(sessionId);
    if (!m) return;
    if (m.groupId) raceWinner.set(m.groupId, sessionId);
    detail.refreshRace();
    try {
      await openDiffFor(sessionId);
    } catch {
      /* diff is best-effort here */
    }
    const mergeCmd = `git merge ${m.branch}`;
    await vscode.env.clipboard.writeText(mergeCmd);
    let base = "the base branch";
    try {
      base = await currentRef(m.repoRoot);
    } catch {
      /* ignore */
    }
    vscode.window.showInformationMessage(
      `🏆 Winner: ${m.label || m.branch}. Copied \`${mergeCmd}\` — run it from ${base} to merge.`,
    );
  }

  async function openAllDiffs(groupId: string): Promise<void> {
    const members = registry.byGroup(groupId).filter((m) => m.worktreePath);
    const cols = [vscode.ViewColumn.One, vscode.ViewColumn.Two, vscode.ViewColumn.Three];
    let i = 0;
    for (const m of members) {
      try {
        await openDiffFor(m.sessionId, cols[Math.min(i, cols.length - 1)]);
      } catch {
        /* skip a candidate whose diff fails */
      }
      i++;
    }
  }

  async function rankRace(groupId: string): Promise<void> {
    const members = registry.byGroup(groupId);
    const agents = members
      .map((m) => store.getById(m.sessionId))
      .filter((a): a is AgentSession => !!a && a.managed);
    if (agents.length < 2) {
      vscode.window.showWarningMessage("Race ranking needs at least 2 candidates.");
      return;
    }
    if (!(await requireLlmConsent(context))) return;
    const c = cfg();
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Race: ranking candidates…" },
      async () => {
        try {
          const { rankings } = await runMergeAdvisor(
            agents,
            registry,
            c.get<string>("claudePath", "claude"),
            c.get<string>("insights.mergeModel", "claude-sonnet-4-6"),
          );
          for (const m of members) raceScores.delete(m.sessionId);
          rankings.forEach((r, i) => raceScores.set(r.sessionId, { score: r.score, recommended: i === 0 }));
          detail.refreshRace();
        } catch (e: any) {
          vscode.window.showErrorMessage(`Race ranking: ${e.message}`);
        }
      },
    );
  }

  async function cleanupRace(groupId: string): Promise<void> {
    const members = registry.byGroup(groupId);
    if (members.length === 0) {
      detail.clearRace();
      return;
    }
    const winnerId = raceWinner.get(groupId);
    const items = winnerId ? ["Clean up all", "Keep winner, clean rest"] : ["Clean up"];
    const pick = await vscode.window.showWarningMessage(
      `Clean up ${members.length} race worktree${members.length === 1 ? "" : "s"}? ` +
        `The worktree checkouts are removed (branches are kept); uncommitted changes in them are discarded.`,
      { modal: true },
      ...items,
    );
    if (!pick) return;
    const keepSessionId = pick === "Keep winner, clean rest" ? winnerId : undefined;
    const { removed, errors } = await cleanupGroup(groupId, registry, { keepSessionId });
    if (!keepSessionId) raceWinner.delete(groupId);
    for (const m of members) {
      if (m.sessionId !== keepSessionId) raceScores.delete(m.sessionId);
    }
    store.refresh();
    if (keepSessionId) detail.refreshRace();
    else detail.clearRace();
    vscode.window.showInformationMessage(
      `Agent View: removed ${removed} worktree${removed === 1 ? "" : "s"}.` +
        (errors.length ? ` Errors: ${errors.join("; ")}` : ""),
    );
  }

  // --- Fan-out orchestration ---
  async function runFanOut(text: string): Promise<void> {
    const cwd = defaultCwd();
    if (!cwd) {
      vscode.window.showErrorMessage("Agent View: open a folder/workspace first.");
      return;
    }
    const tasks = parseChecklist(text);
    if (tasks.length === 0) {
      vscode.window.showWarningMessage("Fan-out: no tasks found in that text.");
      return;
    }
    const c = cfg();
    const useWorktree = c.get<boolean>("fanout.useWorktree", true);
    if (useWorktree && !(await isGitRepo(cwd))) {
      vscode.window.showWarningMessage(
        "Fan-out: this folder isn't a git repo, so agents can't run in isolated worktrees. Disable mas.fanout.useWorktree to run them in place.",
      );
      return;
    }
    const max = Math.max(1, c.get<number>("fanout.maxConcurrent", 4));
    const confirm = await vscode.window.showInformationMessage(
      `Fan-out ${tasks.length} task${tasks.length === 1 ? "" : "s"} into ${tasks.length} agent${tasks.length === 1 ? "" : "s"}` +
        ` (up to ${max} running at once)?`,
      { modal: true },
      "Spawn",
    );
    if (confirm !== "Spawn") return;

    const batch = new FanoutBatch(
      { cwd, tasks: tasks.map((t) => ({ task: t })), useWorktree, maxConcurrent: max },
      registry,
      spawnConfig(),
      store,
      (info) => {
        if (info.done) activeBatches.delete(batch);
      },
    );
    activeBatches.add(batch);
    try {
      await batch.start();
    } catch (e: any) {
      vscode.window.showErrorMessage(`Fan-out: ${e.message}`);
    }
    nudgeHooksForLive();
    setTimeout(() => store.refresh(), 800);
    vscode.window.showInformationMessage(
      `📋 Fan-out started: ${tasks.length} agent${tasks.length === 1 ? "" : "s"} (${max} at a time).`,
    );
  }

  function nudgeHooksForLive(): void {
    if (hooksInstalled()) return;
    vscode.window
      .showInformationMessage(
        "Agent View: install hooks for live progress of these agents?",
        "Configure Hooks",
        "Not now",
      )
      .then((pick) => {
        if (pick === "Configure Hooks") vscode.commands.executeCommand("mas.configureHooks");
      });
  }

  // --- Insights (Conflict Radar + Attention Router) ---
  const insights = new InsightsController(store, context, () => {
    const c = cfg();
    return {
      conflictRadar: c.get<boolean>("conflictRadar.enabled", false),
      attentionRouter: c.get<boolean>("attentionRouter.enabled", false),
      claudePath: c.get<string>("claudePath", "claude"),
      triageModel: c.get<string>("insights.triageModel", "claude-haiku-4-5"),
    };
  });

  // --- Providers ---
  const tree = new AgentsProvider(store);
  const treeView = vscode.window.createTreeView("mas.agents", { treeDataProvider: tree });

  const reportErr = (e: any) => vscode.window.showErrorMessage(`Agent View: ${e?.message || e}`);
  const webviewHandlers: WebviewHandlers = {
    newAgent: runNewAgent,
    pickWinner: (id) => void pickWinner(id).catch(reportErr),
    openCandidateDiff: (id) =>
      openDiffFor(id).catch((e) => vscode.window.showErrorMessage(`Agent View: diff failed — ${e.message}`)),
    openAllDiffs: (gid) => void openAllDiffs(gid).catch(reportErr),
    rankRace: (gid) => void rankRace(gid).catch(reportErr),
    cleanupRace: (gid) => void cleanupRace(gid).catch(reportErr),
    fanOut: (txt) => void runFanOut(txt).catch(reportErr),
    buildRace,
  };
  const detail = new DetailViewProvider(context.extensionUri, store, insights, webviewHandlers);

  context.subscriptions.push(
    treeView,
    vscode.window.registerWebviewViewProvider(DetailViewProvider.viewId, detail),
  );

  // --- Hook server (live status + live "now doing X") ---
  const hookServer = new HookServer(store, (event) => {
    const id = event?.session_id || event?.sessionId;
    if (!id) return;
    const name = event?.hook_event_name || event?.hookEventName;
    if (name === "PreToolUse" && event?.tool_name) {
      store.applyLiveAction(id, humanizeTool(event.tool_name, event.tool_input));
    } else if (
      name === "PostToolUse" ||
      name === "PostToolUseFailure" ||
      name === "Stop" ||
      name === "SubagentStop" ||
      name === "SessionEnd"
    ) {
      // Tool finished (or turn ended) — clear the live phrase so the UI doesn't
      // keep showing "Running: …" after it's done; falls back to lastAction.
      store.applyLiveAction(id, undefined);
    }
  });
  const port = cfg().get<number>("hookPort", 47800);
  hookServer.start(port).catch((e) => {
    console.warn(`[claude-code-agent-view] hook server failed on port ${port}: ${e.message}`);
  });
  context.subscriptions.push({ dispose: () => hookServer.dispose() });

  // --- Notifications (needs-you / finished / error) ---
  const notifications = new NotificationController(
    store,
    () => {
      const c = cfg();
      return {
        enabled: c.get<boolean>("notifications.enabled", true),
        sound: c.get<boolean>("notifications.sound", true),
        onWaiting: c.get<boolean>("notifications.onWaiting", true),
        onDone: c.get<boolean>("notifications.onDone", true),
        onError: c.get<boolean>("notifications.onError", true),
      };
    },
    {
      focus: (id) => {
        const a = store.getById(id);
        terminals.focus(id, `Claude Code ${a?.gitBranch || ""}`.trim());
      },
      reveal: (id) => {
        vscode.commands.executeCommand("mas.detail.focus");
        detail.select(id);
      },
      openDiff: (id) =>
        openDiffFor(id).catch((e) => vscode.window.showErrorMessage(`Agent View: diff failed — ${e.message}`)),
    },
  );
  notifications.start();
  context.subscriptions.push({ dispose: () => notifications.dispose() });

  // --- Commands ---
  context.subscriptions.push(
    vscode.commands.registerCommand("mas.newAgent", runNewAgent),
    vscode.commands.registerCommand("mas.refresh", () => store.refresh()),

    vscode.commands.registerCommand("mas.openAgent", (arg?: AgentSession | string) => {
      const id = sessionIdOf(arg);
      if (!id) return;
      vscode.commands.executeCommand("mas.detail.focus");
      detail.select(id);
    }),

    vscode.commands.registerCommand("mas.focusTerminal", (arg?: AgentSession | string) => {
      const id = sessionIdOf(arg);
      if (!id) return;
      const agent = store.getById(id);
      const ok = terminals.focus(id, `Claude Code ${agent?.gitBranch || ""}`.trim());
      if (!ok)
        vscode.window.showWarningMessage(
          "Agent View: no live terminal for this agent (it may be external or closed).",
        );
    }),

    vscode.commands.registerCommand("mas.stopAgent", async (arg?: AgentSession | string) => {
      const id = sessionIdOf(arg);
      if (!id) return;
      const managed = registry.get(id);
      const confirm = await vscode.window.showWarningMessage(
        `Stop agent ${managed?.label || id.slice(0, 8)}?`,
        { modal: true },
        "Stop",
      );
      if (confirm !== "Stop") return;
      terminals.stop(id, `Claude Code ${managed?.branch || ""}`.trim());
      await registry.remove(id);
      store.refresh();
    }),

    vscode.commands.registerCommand("mas.openDiff", async (arg?: AgentSession | string) => {
      const id = sessionIdOf(arg);
      if (!id) return;
      try {
        await openDiffFor(id);
      } catch (e: any) {
        vscode.window.showErrorMessage(`Agent View: diff failed — ${e.message}`);
      }
    }),

    vscode.commands.registerCommand("mas.raceAgents", async () => {
      const cwd = defaultCwd();
      if (!cwd) {
        vscode.window.showErrorMessage("Agent View: open a folder/workspace first.");
        return;
      }
      if (!(await isGitRepo(cwd))) {
        vscode.window.showWarningMessage(
          "Agent Race needs a git repository — each contender runs in its own worktree.",
        );
        return;
      }
      const task = await vscode.window.showInputBox({
        title: "Agent Race",
        prompt: "Task to give every contender (they all get the same prompt)",
        placeHolder: "e.g. Fix the failing auth test",
      });
      if (!task) return;
      const defaultCount = cfg().get<number>("race.defaultCount", 3);
      const countPick = await vscode.window.showQuickPick(["2", "3", "4", "5"], {
        title: "How many agents should race?",
        placeHolder: `default ${defaultCount}`,
      });
      if (countPick === undefined) return;
      const count = parseInt(countPick, 10) || defaultCount;
      try {
        const { groupId } = await spawnRace({ cwd, task, count }, registry, spawnConfig());
        vscode.commands.executeCommand("mas.detail.focus");
        detail.openRace(groupId);
        nudgeHooksForLive();
        setTimeout(() => store.refresh(), 800);
        vscode.window.showInformationMessage(
          `🏁 Race started: ${count} agents on “${truncate(task, 60)}”.`,
        );
      } catch (e: any) {
        vscode.window.showErrorMessage(`Agent View: failed to start race — ${e.message}`);
      }
    }),

    vscode.commands.registerCommand("mas.fanOutAgents", () => {
      vscode.commands.executeCommand("mas.detail.focus");
      detail.openFanout();
    }),

    vscode.commands.registerCommand("mas.fanOutSelection", () => {
      const ed = vscode.window.activeTextEditor;
      const sel = ed && !ed.selection.isEmpty ? ed.document.getText(ed.selection) : "";
      if (!sel.trim()) {
        vscode.window.showWarningMessage(
          "Fan-out: select some lines first, or use the Fan-out tab in the Agent View panel.",
        );
        return;
      }
      void runFanOut(sel);
    }),

    vscode.commands.registerCommand("mas.cleanupWorktrees", async () => {
      const groups = new Map<string, ManagedAgent[]>();
      for (const m of registry.all()) {
        if (!m.groupId) continue;
        const arr = groups.get(m.groupId) ?? [];
        arr.push(m);
        groups.set(m.groupId, arr);
      }
      if (groups.size === 0) {
        vscode.window.showInformationMessage("Agent View: no race/fan-out worktree groups to clean up.");
        return;
      }
      const items = [...groups.entries()].map(([gid, ms]) => ({
        label: `${ms[0].groupRole === "race" ? "🏁" : "📋"} ${gid} · ${ms.length} agent${ms.length === 1 ? "" : "s"}`,
        description: ms[0].task ? truncate(ms[0].task, 50) : "",
        gid,
      }));
      const pick = await vscode.window.showQuickPick(items, {
        title: "Clean up which group's worktrees?",
      });
      if (!pick) return;
      const confirm = await vscode.window.showWarningMessage(
        `Remove ${groups.get(pick.gid)!.length} worktrees for ${pick.gid}? Branches are kept.`,
        { modal: true },
        "Clean up",
      );
      if (confirm !== "Clean up") return;
      const { removed, errors } = await cleanupGroup(pick.gid, registry);
      raceWinner.delete(pick.gid);
      store.refresh();
      vscode.window.showInformationMessage(
        `Agent View: removed ${removed} worktree${removed === 1 ? "" : "s"}.` +
          (errors.length ? ` Errors: ${errors.join("; ")}` : ""),
      );
    }),

    vscode.commands.registerCommand("mas.configureHooks", async () => {
      try {
        const p = installHooks(cfg().get<number>("hookPort", 47800));
        vscode.window.showInformationMessage(
          `Agent View: hooks installed in ${p}. New Claude Code sessions will stream live status.`,
        );
      } catch (e: any) {
        vscode.window.showErrorMessage(`Agent View: could not install hooks — ${e.message}`);
      }
    }),

    vscode.commands.registerCommand("mas.removeHooks", async () => {
      try {
        const p = removeHooks();
        vscode.window.showInformationMessage(`Agent View: removed agent-view hooks from ${p}.`);
      } catch (e: any) {
        vscode.window.showErrorMessage(`Agent View: could not remove hooks — ${e.message}`);
      }
    }),

    vscode.commands.registerCommand("mas.mergeAdvisor", async () => {
      const managed = store.list().filter((a) => a.managed);
      if (managed.length < 2) {
        vscode.window.showWarningMessage(
          "Merge Advisor needs at least 2 Agent View-spawned (worktree) agents to compare.",
        );
        return;
      }
      if (!(await requireLlmConsent(context))) return;
      const c = cfg();
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Merge Advisor: ranking agents…" },
        async () => {
          try {
            const { report } = await runMergeAdvisor(
              managed,
              registry,
              c.get<string>("claudePath", "claude"),
              c.get<string>("insights.mergeModel", "claude-sonnet-4-6"),
            );
            const doc = await vscode.workspace.openTextDocument({ content: report, language: "markdown" });
            await vscode.window.showTextDocument(doc, { preview: true });
          } catch (e: any) {
            vscode.window.showErrorMessage(`Merge Advisor: ${e.message}`);
          }
        },
      );
    }),
  );

  context.subscriptions.push({ dispose: () => store.dispose() });
  context.subscriptions.push({ dispose: () => terminals.dispose() });
  context.subscriptions.push({ dispose: () => insights.dispose() });
  context.subscriptions.push({
    dispose: () => {
      for (const b of activeBatches) b.dispose();
      activeBatches.clear();
    },
  });

  store.start();
  insights.start();

  // Gentle nudge to enable live status the first time.
  if (!hooksInstalled()) {
    vscode.window
      .showInformationMessage(
        "Agent View is monitoring your Claude Code sessions. Enable hooks for real-time status?",
        "Configure Hooks",
        "Not now",
      )
      .then((pick) => {
        if (pick === "Configure Hooks") vscode.commands.executeCommand("mas.configureHooks");
      });
  }
}

export function deactivate(): void {
  // subscriptions disposed by VS Code
}
