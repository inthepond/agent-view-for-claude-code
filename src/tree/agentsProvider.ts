import * as vscode from "vscode";
import { AgentSession } from "../types";
import { AgentStore } from "../store";
import { relativeTime, formatTokens, statusIcon } from "../util/format";

export class AgentsProvider implements vscode.TreeDataProvider<AgentSession> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly store: AgentStore) {
    store.onDidChange(() => this._onDidChangeTreeData.fire());
  }

  getTreeItem(agent: AgentSession): vscode.TreeItem {
    const hasChildren = (agent.subagents?.length || 0) > 0;

    // Subagents share near-identical opening lines, so lead with what they're
    // doing now; sessions keep their (distinct) task prompt as the label.
    const label =
      agent.kind === "subagent"
        ? agent.lastAction || agent.label || agent.sessionId.slice(0, 8)
        : agent.label || agent.sessionId.slice(0, 8);

    const item = new vscode.TreeItem(
      label,
      hasChildren
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );

    const bits: string[] = [];
    if (agent.kind === "subagent" && agent.agentType) bits.push(agent.agentType);
    else if (agent.lastAction) bits.push("▸ " + agent.lastAction);
    if (agent.managed) bits.push("⎇ " + (agent.gitBranch || "worktree"));
    bits.push(relativeTime(agent.lastActivity));
    item.description = bits.join(" · ");

    item.iconPath = statusIcon(agent.status);
    item.tooltip = this.tooltip(agent);
    item.contextValue =
      agent.kind === "subagent" ? "subagent" : agent.managed ? "agent.managed" : "agent";
    item.id = agent.sessionId + ":" + agent.kind;
    item.command = {
      command: "mas.openAgent",
      title: "Open Agent",
      arguments: [agent],
    };
    return item;
  }

  getChildren(element?: AgentSession): AgentSession[] {
    if (!element) return this.store.list();
    return element.subagents || [];
  }

  private tooltip(agent: AgentSession): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${agent.label}**\n\n`);
    md.appendMarkdown(`- Status: \`${agent.status}\`${agent.statusSource ? ` (${agent.statusSource})` : ""}\n`);
    if (agent.lastAction) md.appendMarkdown(`- Now: ${agent.lastAction}\n`);
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
