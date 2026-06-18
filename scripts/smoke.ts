// Smoke test for the pure data layer (no vscode dependency).
// Run: npx esbuild --bundle --platform=node scripts/smoke.ts | node
import { discoverAgents } from "../src/discovery";
import { readMessages } from "../src/transcript";

const agents = discoverAgents({ recentDays: 14 });
console.log(`\n=== discovered ${agents.length} recent sessions ===`);
for (const a of agents.slice(0, 12)) {
  const subs = a.subagents?.length || 0;
  console.log(
    `${a.status.padEnd(8)} ${(a.model || "?").replace(/^claude-/, "").padEnd(14)} ` +
      `tok=${String(a.tokens.input + a.tokens.output + a.tokens.cacheRead + a.tokens.cacheCreate).padStart(8)} ` +
      `msgs=${String(a.messageCount).padStart(3)} subs=${subs}  ${a.label.slice(0, 48)}`,
  );
}

const withSubs = agents.find((a) => (a.subagents?.length || 0) > 0);
if (withSubs) {
  console.log(`\n=== subagents of "${withSubs.label.slice(0, 40)}" (${withSubs.subagents!.length}) ===`);
  for (const s of withSubs.subagents!.slice(0, 8)) {
    console.log(`  - ${s.status.padEnd(8)} ${s.agentType || "?"} now="${(s.lastAction || "—").slice(0, 50)}"`);
  }
}

const first = agents[0];
if (first) {
  const msgs = readMessages(first.jsonlPath, 6);
  console.log(`\n=== last ${msgs.length} messages of newest session ===`);
  for (const m of msgs) {
    console.log(`  [${m.role}${m.tool ? ":" + m.tool : ""}] ${m.text.slice(0, 70)}`);
  }
}
console.log();
