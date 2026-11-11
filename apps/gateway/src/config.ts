import { fileURLToPath } from "node:url";

export const config = {
  port: Number(process.env.PORT ?? 4000),
  publicUrl: process.env.GATEWAY_URL ?? "http://localhost:4000",
  dbPath: process.env.TOLL_DB ?? fileURLToPath(new URL("../../../data/toll.db", import.meta.url)),
  secret: process.env.TOLL_SECRET ?? "dev-only-secret-change-me",
  paypal: {
    clientId: process.env.PAYPAL_CLIENT_ID ?? "",
    clientSecret: process.env.PAYPAL_CLIENT_SECRET ?? "",
    apiBase: process.env.PAYPAL_API_BASE ?? "https://api-m.sandbox.paypal.com",
    webhookId: process.env.PAYPAL_WEBHOOK_ID ?? "",
  },
  payoutReceiverEmail: process.env.PAYOUT_RECEIVER_EMAIL ?? "",
  model: process.env.TOLL_MODEL ?? "claude-opus-5-5",
  judgeModel: process.env.TOLL_JUDGE_MODEL ?? process.env.TOLL_MODEL ?? "claude-opus-5-5",
};

if (config.secret === "dev-only-secret-change-me") {
  console.warn("[toll] TOLL_SECRET is not set; using an insecure development secret.");
}
