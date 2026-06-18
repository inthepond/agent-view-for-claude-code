import * as vscode from "vscode";

const KEY = "mas.llmConsent";

/**
 * One-time consent gate for AI features. They run Claude Code headlessly and
 * therefore consume the user's Claude subscription usage — make that explicit
 * before the first call, then remember the decision.
 */
export async function requireLlmConsent(context: vscode.ExtensionContext): Promise<boolean> {
  if (context.globalState.get<boolean>(KEY)) return true;
  const pick = await vscode.window.showWarningMessage(
    "This AI feature runs Claude Code in the background (`claude -p`) and will consume your Claude subscription usage. Enable AI features?",
    { modal: true, detail: "Conflict Radar is local-only and unaffected. Only the Attention Router and Merge Advisor use your subscription." },
    "Enable",
  );
  if (pick === "Enable") {
    await context.globalState.update(KEY, true);
    return true;
  }
  return false;
}

export function hasLlmConsent(context: vscode.ExtensionContext): boolean {
  return !!context.globalState.get<boolean>(KEY);
}
