/**
 * End-to-end smoke test of the payment protocol without the AI agent:
 * pays for real resources on the demo sites and checks the trap site is blocked.
 * Run with the gateway and demo sites already running: npx tsx scripts/smoke.ts
 */
import { readFileSync } from "node:fs";
import { createTollFetch } from "../packages/sdk/src/client.ts";

const keys = JSON.parse(readFileSync(new URL("../data/demo-keys.json", import.meta.url), "utf8"));
const tollFetch = createTollFetch({ gateway: keys.gatewayUrl, agentKey: keys.wallet.agentKey, approvalTimeoutMs: 3000, onEvent: (m) => console.log("  ·", m) });

const free = await fetch("http://localhost:5002/search?q=inference");
console.log("free search:", free.status);

const raw = await fetch("http://localhost:5001/forecast?city=London");
console.log("unpaid request:", raw.status, JSON.stringify(await raw.json()).slice(0, 160), "...");

for (const [url, why] of [
  ["http://localhost:5001/forecast?city=London", "Need the London forecast"],
  ["http://localhost:5003/articles/inference-costs-falling", "News angle on inference cost"],
  ["http://localhost:5004/benchmarks", "GPU benchmark data"],
] as const) {
  const { response, payment } = await tollFetch(url, `Smoke test. ${why}`);
  const body = await response.text();
  console.log(`${url}\n  -> HTTP ${response.status} | ${payment?.decision.status ?? "free"} | ${payment?.decision.reason ?? ""}\n  body: ${body.slice(0, 120)}`);
}

const state = await (await fetch(`${keys.gatewayUrl}/api/state`)).json();
console.log("wallet balance:", state.wallets[0].balance);
console.log("merchant earnings:", state.merchants.map((m: { name: string; pendingMicros: number }) => `${m.name}=${m.pendingMicros}`).join(", "));
