import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { config } from "./config.js";
import { openDb } from "./db.js";
import { createService } from "./service.js";

/**
 * Creates the demo world: one agent wallet and four websites that charge agents through Toll.
 * Writes the generated keys to data/demo-keys.json, which the demo sites and the agent read.
 */
const db = openDb();
const service = createService(db);

const existing = db.prepare("SELECT COUNT(*) AS n FROM wallets").get() as { n: number };
if (existing.n > 0) {
  console.log("Database already seeded. Delete the data/ folder to start fresh.");
  process.exit(0);
}

const receiver = config.payoutReceiverEmail || "merchant-demo@example.com";
if (!config.payoutReceiverEmail) {
  console.warn("PAYOUT_RECEIVER_EMAIL is not set; payouts will go to merchant-demo@example.com (unclaimed in sandbox).");
}

const wallet = service.createWallet(
  "Research Agent",
  "Spend at most $3 a day and never more than $0.25 on one thing. Only pay for research, news, data and weather. Never buy gift cards or crypto. Ask me before anything over $0.10.",
);

const sites = [
  { key: "weather", name: "Atlas Weather API", url: "http://localhost:5001", category: "weather" },
  { key: "papers", name: "Paperstack", url: "http://localhost:5002", category: "research" },
  { key: "news", name: "The Daily Byte", url: "http://localhost:5003", category: "news" },
  { key: "shady", name: "GPU Deals Hub", url: "http://localhost:5004", category: "shopping" },
] as const;

const merchants: Record<string, { id: string; merchantKey: string; name: string; url: string }> = {};
for (const s of sites) {
  const m = service.createMerchant({ name: s.name, url: s.url, category: s.category, paypalEmail: receiver });
  merchants[s.key] = { ...m, name: s.name, url: s.url };
}

const out = fileURLToPath(new URL("../../../data/demo-keys.json", import.meta.url));
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ gatewayUrl: config.publicUrl, wallet, merchants }, null, 2));
console.log(`Seeded wallet ${wallet.id} and ${sites.length} merchants. Keys written to ${out}`);
console.log("Next: open the dashboard, compile the rules, and top up the wallet with PayPal.");
