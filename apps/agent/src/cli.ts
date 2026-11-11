import { DEFAULT_TASK, runAgent } from "./agent.ts";

const task = process.argv.slice(2).join(" ").trim() || DEFAULT_TASK;
const colors = { thought: 90, tool: 36, payment: 33, blocked: 31, result: 32, error: 31 } as const;

console.log(`\nTask: ${task}\n`);
const { receipts } = await runAgent(task, (kind, text) => {
  console.log(`\x1b[${colors[kind]}m[${kind}]\x1b[0m ${text}`);
});
console.log("\nPayments:");
for (const r of receipts) console.log(`  ${r.status.padEnd(16)} ${r.amount.padEnd(9)} ${r.url}${r.reason ? `  (${r.reason})` : ""}`);
