import * as vscode from "vscode";
import { AgentStore } from "./store";
import { Registry } from "./orchestrator/registry";
import { spawnAgent, SpawnConfig } from "./orchestrator/spawn";
import { terminals } from "./orchestrator/terminals";
import { worktreeDiff, currentRef } from "./orchestrator/worktree";
import { AgentsProvider } from "./tree/agentsProvider";
import { DetailViewProvider } from "./webview/provider";
import { HookServer } from "./hooks/server";
import { installHooks, removeHooks, hooksInstalled } from "./hooks/installer";
import { InsightsController } from "./features/insights";
import { requireLlmConsent } from "./features/consent";
import { runMergeAdvisor } from "./features/mergeAdvisor";
import { AgentSession, AgentStatus } from "./types";
import { statusEmoji } from "./util/format";

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
    vscode.window.activeTextEditor &&
    vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri)?.uri.fsPath
  ) || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
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
  const detail = new DetailViewProvider(context.extensionUri, store, insights, runNewAgent);

  context.subscriptions.push(
    treeView,
    vscode.window.registerWebviewViewProvider(DetailViewProvider.viewId, detail),
  );

  // --- Hook server (live status) ---
  const hookServer = new HookServer(store);
  const port = cfg().get<number>("hookPort", 47800);
  hookServer.start(port).catch((e) => {
    console.warn(`[claude-code-agent-view] hook server failed on port ${port}: ${e.message}`);
  });
  context.subscriptions.push({ dispose: () => hookServer.dispose() });

  // --- Notifications on status change to "waiting" ---
  const lastStatus = new Map<string, AgentStatus>();
  store.onDidChange(() => {
    for (const a of store.list()) {
      const prev = lastStatus.get(a.sessionId);
      if (prev && prev !== "waiting" && a.status === "waiting") {
        vscode.window
          .showInformationMessage(`${statusEmoji("waiting")} ${a.label} needs your input`, "Focus")
          .then((pick) => {
            if (pick === "Focus") terminals.focus(a.sessionId, `Claude Code ${a.gitBranch || ""}`.trim());
          });
      }
      lastStatus.set(a.sessionId, a.status);
    }
  });

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
      if (!ok) vscode.window.showWarningMessage("Agent View: no live terminal for this agent (it may be external or closed).");
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
      const managed = registry.get(id);
      if (!managed?.worktreePath) {
        vscode.window.showWarningMessage("Agent View: diff is only available for managed worktree agents.");
        return;
      }
      try {
        const base = await currentRef(managed.repoRoot);
        const diff = await worktreeDiff(managed.worktreePath, base);
        const doc = await vscode.workspace.openTextDocument({
          content: diff || "(no changes yet)",
          language: "diff",
        });
        await vscode.window.showTextDocument(doc, { preview: true });
      } catch (e: any) {
        vscode.window.showErrorMessage(`Agent View: diff failed — ${e.message}`);
      }
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
