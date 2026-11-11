import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { config } from "./config.js";
import { openDb } from "./db.js";
import { subscribe } from "./events.js";
import { PayPalError, verifyWebhook } from "./paypal.js";
import { aiModelLabel, aiProvider } from "./ai.js";
import { TollError, createService } from "./service.js";

const db = openDb();
const service = createService(db);
const app = express();

app.use(cors());
app.use(express.json({ limit: "256kb" }));

const bearer = (req: Request) => (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown> | unknown) =>
  (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res))
      .then((body) => {
        if (!res.headersSent) res.json(body);
      })
      .catch(next);

// ---------- Agent API (called by agents and the Toll client SDK) ----------

app.post(
  "/v1/payments",
  wrap((req) => service.requestPayment(bearer(req), req.body)),
);
app.get(
  "/v1/payments/:id",
  wrap((req) => service.getPaymentForAgent(bearer(req), req.params.id)),
);

// ---------- Merchant API (called by the toll-express middleware) ----------

app.post(
  "/v1/verify",
  wrap((req) => service.verifyToken(bearer(req), String(req.body.token ?? ""), String(req.body.resource ?? ""))),
);
app.post(
  "/v1/payments/:id/refund",
  wrap((req) => service.refundPayment(req.params.id, bearer(req))),
);

// ---------- Dashboard API ----------

app.get("/api/config", (_req, res) => {
  res.json({ paypalClientId: config.paypal.clientId, paypalEnv: config.paypal.apiBase.includes("sandbox") ? "sandbox" : "live" });
});
app.get("/api/state", wrap(() => service.state()));
app.get("/api/events", (_req, res) => subscribe(res));
app.put(
  "/api/wallets/:id/rules",
  wrap((req) => service.setRules(req.params.id, String(req.body.rulesText ?? ""))),
);
app.post(
  "/api/wallets/:id/topup/orders",
  wrap((req) => service.createTopupOrder(req.params.id, Number(req.body.amountUsd))),
);
app.post(
  "/api/wallets/:id/topup/orders/:orderId/capture",
  wrap((req) => service.captureTopup(req.params.orderId, req.params.id)),
);
app.post(
  "/api/wallets/:id/withdraw",
  wrap((req) => service.withdraw(req.params.id, String(req.body.captureId), Number(req.body.amountUsd))),
);
app.post(
  "/api/approvals/:id",
  wrap((req) => service.resolveApproval(req.params.id, Boolean(req.body.approve))),
);
app.post(
  "/api/payments/:id/refund",
  wrap((req) => service.refundPayment(req.params.id)),
);
app.post("/api/settle", wrap(() => service.settle()));
app.post(
  "/api/settlements/:id/refresh",
  wrap((req) => service.refreshSettlement(req.params.id)),
);

// ---------- PayPal webhooks ----------

app.post(
  "/webhooks/paypal",
  wrap(async (req, res) => {
    const event = req.body as { id: string; event_type: string; resource?: any };
    const ok = await verifyWebhook(req.headers as Record<string, string>, event).catch(() => false);
    if (!ok) {
      res.status(400).json({ error: "webhook signature not verified" });
      return;
    }
    const fresh = db.prepare("INSERT OR IGNORE INTO webhook_events (id, event_type) VALUES (?, ?)").run(event.id, event.event_type);
    if (fresh.changes === 1) {
      const r = event.resource ?? {};
      if (event.event_type === "PAYMENT.CAPTURE.COMPLETED" && r.custom_id) {
        const orderId = r.supplementary_data?.related_ids?.order_id ?? "";
        service.creditTopup(r.id, orderId, r.custom_id, Math.round(Number(r.amount?.value ?? 0) * 1_000_000), null);
      }
      if (event.event_type.startsWith("PAYMENT.PAYOUTSBATCH.") && r.batch_header?.payout_batch_id) {
        service.setSettlementStatus(r.batch_header.payout_batch_id, r.batch_header.batch_status);
      }
    }
    return { received: true };
  }),
);

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof TollError) return res.status(err.status).json({ error: err.message });
  if (err instanceof PayPalError) {
    console.error("[paypal]", err.status, JSON.stringify(err.details));
    return res.status(502).json({ error: `PayPal: ${err.message}`, details: err.details });
  }
  console.error(err);
  res.status(500).json({ error: err instanceof Error ? err.message : "Internal error" });
});

setInterval(() => service.expireUnusedPayments(), 60_000).unref();

app.listen(config.port, () => {
  const s = service.state();
  console.log(`[toll] gateway on ${config.publicUrl}`);
  console.log(`[toll] PayPal: ${s.paypalEnabled ? "configured" : "NOT configured (set PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET)"}`);
  console.log(`[toll] AI judge: ${s.aiEnabled ? `on (${aiProvider()}: ${aiModelLabel()})` : "OFF (set GEMINI_API_KEY or ANTHROPIC_API_KEY)"}`);
  if (!s.wallets.length) console.log("[toll] No wallets yet. Run `npm run seed` first.");
});
