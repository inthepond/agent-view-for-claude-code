import * as vscode from "vscode";
import { AgentSession } from "../types";
import { AgentStore } from "../store";
import { relativeTime, formatTokens, statusIcon, truncate } from "../util/format";

export class AgentsProvider implements vscode.TreeDataProvider<AgentSession> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly store: AgentStore) {
    store.onDidChange(() => this._onDidChangeTreeData.fire());
  }

  getTreeItem(agent: AgentSession): vscode.TreeItem {
    const hasChildren = (agent.subagents?.length || 0) > 0;
    // A parent often goes idle while its subagents do the work — surface that
    // its subagents are still busy instead of looking dormant.
    const activeSubs =
      agent.kind === "session"
        ? (agent.subagents || []).filter(
            (s) => s.status === "running" || s.status === "waiting" || s.status === "thinking",
          ).length
        : 0;
    // The live hook-driven action is fresher than the per-turn transcript one.
    const action = agent.liveAction || agent.lastAction;

    // Subagents share near-identical opening lines, so lead with what they're
    // doing now; sessions keep their (distinct) task prompt as the label.
    const label =
      agent.kind === "subagent"
        ? (action && truncate(action, 100)) || agent.label || agent.sessionId.slice(0, 8)
        : agent.label || agent.sessionId.slice(0, 8);

    const item = new vscode.TreeItem(
      label,
      hasChildren
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );

    // A dismissed agent has had its status overridden to idle by the store, so
    // detect it by the flag, not the status.
    const dismissed = !!agent.acknowledged;
    const needsYou = !dismissed && (agent.status === "waiting" || agent.status === "error");

    const bits: string[] = [];
    if (agent.groupRole) bits.push(agent.groupRole === "race" ? "race" : "batch");
    if (dismissed) bits.push("dismissed");
    // A current tool failure is the most important thing to see at a glance.
    if (agent.lastError) bits.push(truncate(agent.lastError, 60));
    if (agent.kind === "subagent" && agent.agentType) bits.push(agent.agentType);
    else if (action) bits.push("▸ " + truncate(action, 100));
    // The agent's own plan progress — persistent, unlike the per-tool action.
    if (agent.plan && agent.plan.total > 0) bits.push(`${agent.plan.done}/${agent.plan.total}`);
    if (agent.managed) bits.push("⎇ " + (agent.gitBranch || "worktree"));
    if (activeSubs > 0) bits.push(`${activeSubs} subagent${activeSubs === 1 ? "" : "s"} working`);
    bits.push(relativeTime(agent.lastActivity));
    item.description = bits.join(" · ");

    // Spin while subagents work, even though the parent itself is resting.
    // Dismissed agents already read as idle (status overridden), so the normal
    // idle icon applies — no special-casing needed.
    item.iconPath =
      activeSubs > 0 && agent.status !== "running"
        ? new vscode.ThemeIcon("loading~spin")
        : statusIcon(agent.status);
    item.tooltip = this.tooltip(agent);
    const base =
      agent.kind === "subagent" ? "subagent" : agent.managed ? "agent.managed" : "agent";
    // Suffixes drive the inline dismiss / restore actions (see package.json menus).
    item.contextValue = base + (dismissed ? ".acked" : needsYou ? ".needsYou" : "");
    item.id = agent.sessionId + ":" + agent.kind;
    item.command = {
      command: "mas.openAgent",
      title: "Open Agent",
      arguments: [agent],
    };
    return item;
  }

  getChildren(element?: AgentSession): AgentSession[] {
    if (!element) return this.store.listVisible();
    return element.subagents || [];
  }

  private tooltip(agent: AgentSession): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${agent.label}**\n\n`);
    md.appendMarkdown(`- Status: \`${agent.status}\`${agent.statusSource ? ` (${agent.statusSource})` : ""}\n`);
    if (agent.acknowledged) md.appendMarkdown(`- Dismissed from "needs you" — resurfaces on new activity\n`);
    const now = agent.liveAction || agent.lastAction;
    if (now) md.appendMarkdown(`- Now: ${truncate(now, 200)}\n`);
    if (agent.plan && agent.plan.total > 0) {
      md.appendMarkdown(
        `- Plan: ${agent.plan.done}/${agent.plan.total} done${agent.plan.current ? ` · ${truncate(agent.plan.current, 80)}` : ""}\n`,
      );
    }
    if (agent.lastError) md.appendMarkdown(`- Error: ${truncate(agent.lastError, 200)}\n`);
    if (agent.groupRole) md.appendMarkdown(`- Group: \`${agent.groupRole}\`\n`);
    if (agent.agentType) md.appendMarkdown(`- Type: \`${agent.agentType}\`\n`);
    if (agent.model) md.appendMarkdown(`- Model: \`${agent.model}\`\n`);
    md.appendMarkdown(`- Tokens: ${formatTokens(agent.tokens)}\n`);
    if (agent.cwd) md.appendMarkdown(`- Cwd: \`${agent.cwd}\`\n`);
    if (agent.gitBranch) md.appendMarkdown(`- Branch: \`${agent.gitBranch}\`\n`);
    md.appendMarkdown(`- Session: \`${agent.sessionId}\`\n`);
    md.appendMarkdown(`- Messages: ${agent.messageCount}\n`);
    return md;
  }
}
