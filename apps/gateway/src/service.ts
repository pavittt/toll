import { randomUUID } from "node:crypto";
import { aiConfigured, compileRules, judgePayment } from "./ai.js";
import { type DB, type Merchant, type Payment, type Policy, type Wallet, newId, newKey } from "./db.js";
import { emit } from "./events.js";
import { formatUsd, parsePrice, usdToMicros, wholeCents } from "./money.js";
import * as paypal from "./paypal.js";
import { DEFAULT_POLICY, type Decision, type PaymentRequest, hardChecks, needsOwnerApproval } from "./policy.js";
import { issueToken, readToken } from "./tokens.js";

export class TollError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

const TOKEN_TTL_SECONDS = 300;
const UNUSED_PAYMENT_EXPIRY_MS = 10 * 60_000;
const JUDGE_CACHE_MS = 10 * 60_000;

export type Deps = {
  compile?: typeof compileRules;
  judge?: typeof judgePayment;
  aiEnabled?: () => boolean;
};

export function createService(db: DB, deps: Deps = {}) {
  const compile = deps.compile ?? compileRules;
  const judge = deps.judge ?? judgePayment;
  const aiEnabled = deps.aiEnabled ?? aiConfigured;

  const q = {
    walletById: db.prepare<[string], Wallet>("SELECT * FROM wallets WHERE id = ?"),
    walletByKey: db.prepare<[string], Wallet>("SELECT * FROM wallets WHERE agent_key = ?"),
    merchantById: db.prepare<[string], Merchant>("SELECT * FROM merchants WHERE id = ?"),
    merchantByKey: db.prepare<[string], Merchant>("SELECT * FROM merchants WHERE merchant_key = ?"),
    paymentById: db.prepare<[string], Payment>("SELECT * FROM payments WHERE id = ?"),
    ledger: db.prepare(
      "INSERT INTO ledger (kind, wallet_id, merchant_id, amount_micros, ref, memo) VALUES (@kind, @wallet_id, @merchant_id, @amount_micros, @ref, @memo)",
    ),
  };

  const policyOf = (w: Wallet): Policy => (w.policy_json ? (JSON.parse(w.policy_json) as Policy) : DEFAULT_POLICY);

  function ledger(kind: string, e: { wallet_id?: string | null; merchant_id?: string | null; amount_micros: number; ref?: string | null; memo?: string | null }) {
    q.ledger.run({ kind, wallet_id: e.wallet_id ?? null, merchant_id: e.merchant_id ?? null, amount_micros: e.amount_micros, ref: e.ref ?? null, memo: e.memo ?? null });
  }

  function spentToday(walletId: string): number {
    const row = db
      .prepare<[string], { total: number | null }>(
        "SELECT SUM(amount_micros) AS total FROM payments WHERE wallet_id = ? AND status IN ('approved','consumed') AND created_at >= strftime('%Y-%m-%dT00:00:00.000Z','now')",
      )
      .get(walletId);
    return row?.total ?? 0;
  }

  function publicPayment(p: Payment) {
    const merchant = q.merchantById.get(p.merchant_id);
    return {
      id: p.id,
      walletId: p.wallet_id,
      merchantId: p.merchant_id,
      merchantName: merchant?.name,
      amountMicros: p.amount_micros,
      amount: formatUsd(p.amount_micros),
      resource: p.resource,
      purpose: p.purpose,
      status: p.status,
      decidedBy: p.decision_by,
      reason: p.reason,
      signals: p.signals_json ? (JSON.parse(p.signals_json) as string[]) : [],
      createdAt: p.created_at,
    };
  }

  /** Debits the wallet and credits the merchant atomically. Returns false if funds ran out meanwhile. */
  const charge = db.transaction((p: Payment): boolean => {
    const debit = db
      .prepare("UPDATE wallets SET balance_micros = balance_micros - ? WHERE id = ? AND balance_micros >= ?")
      .run(p.amount_micros, p.wallet_id, p.amount_micros);
    if (debit.changes !== 1) return false;
    db.prepare("UPDATE merchants SET pending_micros = pending_micros + ? WHERE id = ?").run(p.amount_micros, p.merchant_id);
    db.prepare("UPDATE payments SET status = 'approved' WHERE id = ?").run(p.id);
    ledger("charge", { wallet_id: p.wallet_id, merchant_id: p.merchant_id, amount_micros: p.amount_micros, ref: p.id, memo: p.resource });
    return true;
  });

  /** Moves money from the merchant back to the wallet (unused token, or a merchant refund). */
  const reverse = db.transaction((p: Payment, newStatus: "expired" | "refunded", memo: string) => {
    db.prepare("UPDATE merchants SET pending_micros = pending_micros - ? WHERE id = ? AND pending_micros >= ?").run(
      p.amount_micros,
      p.merchant_id,
      p.amount_micros,
    );
    db.prepare("UPDATE wallets SET balance_micros = balance_micros + ? WHERE id = ?").run(p.amount_micros, p.wallet_id);
    db.prepare("UPDATE payments SET status = ? WHERE id = ?").run(newStatus, p.id);
    ledger("refund", { wallet_id: p.wallet_id, merchant_id: p.merchant_id, amount_micros: p.amount_micros, ref: p.id, memo });
  });

  function tokenFor(p: Payment) {
    return issueToken({
      pid: p.id,
      mid: p.merchant_id,
      amt: p.amount_micros,
      res: p.resource,
      exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
    });
  }

  /** The task part of a purpose. Agents send "Task: ...\nWhy this resource: ...", and only the task is a cache key. */
  const taskOf = (purpose: string) => purpose.split("\nWhy this resource:")[0];

  function cachedApproval(walletId: string, merchantId: string, purpose: string, amountMicros: number): Payment | undefined {
    const since = new Date(Date.now() - JUDGE_CACHE_MS).toISOString();
    const task = taskOf(purpose);
    if (!task.trim()) return undefined;
    return db
      .prepare<[string, string, string, number], Payment>(
        "SELECT * FROM payments WHERE wallet_id = ? AND merchant_id = ? AND decision_by IN ('ai_judge','owner') AND status IN ('approved','consumed') AND created_at >= ? AND amount_micros >= ? ORDER BY created_at DESC LIMIT 20",
      )
      .all(walletId, merchantId, since, amountMicros)
      .find((p) => taskOf(p.purpose) === task);
  }

  return {
    policyOf,

    createWallet(name: string, rulesText = "") {
      const id = newId("wal");
      const agentKey = newKey("tk_agent");
      db.prepare("INSERT INTO wallets (id, name, agent_key, rules_text) VALUES (?, ?, ?, ?)").run(id, name, agentKey, rulesText);
      return { id, agentKey };
    },

    async setRules(walletId: string, rulesText: string) {
      const wallet = q.walletById.get(walletId);
      if (!wallet) throw new TollError("Wallet not found", 404);
      if (!aiEnabled()) throw new TollError("Set ANTHROPIC_API_KEY to compile plain-English rules.", 503);
      const policy = await compile(rulesText);
      db.prepare("UPDATE wallets SET rules_text = ?, policy_json = ? WHERE id = ?").run(rulesText, JSON.stringify(policy), walletId);
      emit({ type: "state", reason: "rules_updated" });
      return policy;
    },

    createMerchant(input: { name: string; url: string; category: string; paypalEmail: string }) {
      const id = newId("mer");
      const merchantKey = newKey("tk_merchant");
      db.prepare("INSERT INTO merchants (id, name, url, category, paypal_email, merchant_key) VALUES (?, ?, ?, ?, ?, ?)").run(
        id,
        input.name,
        input.url,
        input.category.toLowerCase(),
        input.paypalEmail,
        merchantKey,
      );
      return { id, merchantKey };
    },

    /** The heart of Toll: an agent asks to pay for a resource that answered 402. */
    async requestPayment(
      agentKey: string,
      input: { payTo: string; amount?: string | number; amountMicros?: number; resource: string; description?: string; purpose?: string },
    ) {
      const wallet = q.walletByKey.get(agentKey);
      if (!wallet) throw new TollError("Unknown agent key", 401);
      const merchant = q.merchantById.get(input.payTo);
      if (!merchant) throw new TollError("Unknown merchant (payTo)", 404);
      const amountMicros =
        input.amountMicros !== undefined
          ? Math.round(Number(input.amountMicros))
          : input.amount !== undefined
            ? parsePrice(input.amount)
            : NaN;
      if (!Number.isFinite(amountMicros)) throw new TollError("Provide amountMicros (integer) or amount (dollars)");
      const req: PaymentRequest = {
        amountMicros,
        merchant,
        resource: input.resource,
        description: input.description ?? "",
        purpose: (input.purpose ?? "").slice(0, 2000),
      };
      const policy = policyOf(wallet);

      let decision: Decision | null = hardChecks(policy, wallet, req, spentToday(wallet.id));
      if (!decision) {
        const cached = cachedApproval(wallet.id, merchant.id, req.purpose, amountMicros);
        if (cached) {
          decision = { decision: "approve", reason: `Same task and merchant were approved recently (${cached.id}).`, decidedBy: "cache", signals: [] };
        }
      }
      if (!decision) {
        if (aiEnabled()) {
          const recent = db
            .prepare<[string], { merchant: string; amount_micros: number; resource: string; status: string }>(
              "SELECT m.name AS merchant, p.amount_micros, p.resource, p.status FROM payments p JOIN merchants m ON m.id = p.merchant_id WHERE p.wallet_id = ? ORDER BY p.created_at DESC LIMIT 10",
            )
            .all(wallet.id)
            .map((r) => ({ merchant: r.merchant, amount: formatUsd(r.amount_micros), resource: r.resource, status: r.status }));
          decision = await judge(policy, wallet.rules_text, req, recent);
        } else {
          decision = { decision: "approve", reason: "Within your hard limits (AI judge is off: no ANTHROPIC_API_KEY).", decidedBy: "rules", signals: ["ai_judge_disabled"] };
        }
      }
      if (decision.decision === "approve" && needsOwnerApproval(policy, amountMicros) && decision.decidedBy !== "cache") {
        decision = { ...decision, decision: "ask_owner", reason: `${decision.reason} Over your approval threshold, so it needs your OK.` };
      }

      const id = newId("pay");
      const status = decision.decision === "approve" ? "approved" : decision.decision === "block" ? "blocked" : "pending_approval";
      db.prepare(
        "INSERT INTO payments (id, wallet_id, merchant_id, amount_micros, resource, description, purpose, status, decision_by, reason, signals_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        id,
        wallet.id,
        merchant.id,
        amountMicros,
        req.resource,
        req.description.slice(0, 2000),
        req.purpose,
        status === "approved" ? "pending_charge" : status,
        decision.decidedBy,
        decision.reason,
        JSON.stringify(decision.signals),
      );
      let payment = q.paymentById.get(id)!;
      let token: string | undefined;
      if (status === "approved") {
        if (!charge(payment)) {
          db.prepare("UPDATE payments SET status = 'blocked', reason = 'Insufficient funds.' WHERE id = ?").run(id);
        } else {
          payment = q.paymentById.get(id)!;
          token = tokenFor(payment);
        }
      } else if (status === "blocked") {
        ledger("blocked", { wallet_id: wallet.id, merchant_id: merchant.id, amount_micros: amountMicros, ref: id, memo: decision.reason });
      }
      payment = q.paymentById.get(id)!;
      const pub = publicPayment(payment);
      emit({ type: "payment", payment: pub });
      return { ...pub, token };
    },

    /** Agents poll this while a payment waits for the owner. */
    getPaymentForAgent(agentKey: string, paymentId: string) {
      const wallet = q.walletByKey.get(agentKey);
      const p = q.paymentById.get(paymentId);
      if (!wallet || !p || p.wallet_id !== wallet.id) throw new TollError("Payment not found", 404);
      return { ...publicPayment(p), token: p.status === "approved" ? tokenFor(p) : undefined };
    },

    resolveApproval(paymentId: string, approve: boolean) {
      const p = q.paymentById.get(paymentId);
      if (!p || p.status !== "pending_approval") throw new TollError("No pending approval with that id", 404);
      if (!approve) {
        db.prepare("UPDATE payments SET status = 'blocked', decision_by = 'owner', reason = 'Declined by the owner.' WHERE id = ?").run(p.id);
        ledger("blocked", { wallet_id: p.wallet_id, merchant_id: p.merchant_id, amount_micros: p.amount_micros, ref: p.id, memo: "Declined by the owner." });
      } else {
        db.prepare("UPDATE payments SET decision_by = 'owner', reason = 'Approved by the owner.' WHERE id = ?").run(p.id);
        if (!charge(q.paymentById.get(p.id)!)) {
          db.prepare("UPDATE payments SET status = 'blocked', reason = 'Insufficient funds.' WHERE id = ?").run(p.id);
        }
      }
      const pub = publicPayment(q.paymentById.get(p.id)!);
      emit({ type: "payment", payment: pub });
      return pub;
    },

    /** Merchants call this (via the middleware) to redeem a token before serving the resource. */
    verifyToken(merchantKey: string, token: string, resource: string) {
      const merchant = q.merchantByKey.get(merchantKey);
      if (!merchant) throw new TollError("Unknown merchant key", 401);
      const claims = readToken(token);
      if (!claims) return { valid: false as const, error: "invalid_or_expired_token" };
      if (claims.mid !== merchant.id) return { valid: false as const, error: "token_for_another_merchant" };
      if (claims.res !== resource) return { valid: false as const, error: "token_for_another_resource" };
      const consumed = db
        .prepare("UPDATE payments SET status = 'consumed', consumed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND status = 'approved'")
        .run(claims.pid);
      if (consumed.changes !== 1) return { valid: false as const, error: "token_already_used" };
      const pub = publicPayment(q.paymentById.get(claims.pid)!);
      emit({ type: "payment", payment: pub });
      return { valid: true as const, paymentId: claims.pid, amountMicros: claims.amt };
    },

    /** Money for approved payments whose token was never redeemed goes back to the wallet. */
    expireUnusedPayments() {
      const cutoff = new Date(Date.now() - UNUSED_PAYMENT_EXPIRY_MS).toISOString();
      const stale = db.prepare<[string], Payment>("SELECT * FROM payments WHERE status = 'approved' AND created_at < ?").all(cutoff);
      for (const p of stale) reverse(p, "expired", "Payment approved but never used; returned to wallet.");
      if (stale.length) emit({ type: "state", reason: "expired_payments" });
      return stale.length;
    },

    refundPayment(paymentId: string, merchantKey?: string) {
      const p = q.paymentById.get(paymentId);
      if (!p || !["approved", "consumed"].includes(p.status)) throw new TollError("Only completed payments can be refunded", 400);
      if (merchantKey) {
        const m = q.merchantByKey.get(merchantKey);
        if (!m || m.id !== p.merchant_id) throw new TollError("Not your payment", 403);
      }
      const m = q.merchantById.get(p.merchant_id)!;
      if (m.pending_micros < p.amount_micros) throw new TollError("This payment was already paid out to the merchant", 409);
      reverse(p, "refunded", "Refunded by merchant.");
      emit({ type: "refund", walletId: p.wallet_id, amountMicros: p.amount_micros, ref: p.id });
      return publicPayment(q.paymentById.get(p.id)!);
    },

    // ---------- PayPal: wallet top-ups ----------

    async createTopupOrder(walletId: string, amountUsd: number) {
      if (!q.walletById.get(walletId)) throw new TollError("Wallet not found", 404);
      if (!(amountUsd >= 1 && amountUsd <= 500)) throw new TollError("Top-ups must be between $1 and $500");
      const order = await paypal.createOrder(amountUsd.toFixed(2), walletId, `topup-${randomUUID()}`);
      return { orderId: order.id };
    },

    creditTopup: db.transaction((captureId: string, orderId: string, walletId: string, amountMicros: number, payerEmail: string | null) => {
      const inserted = db
        .prepare("INSERT OR IGNORE INTO topups (capture_id, order_id, wallet_id, amount_micros, payer_email) VALUES (?, ?, ?, ?, ?)")
        .run(captureId, orderId, walletId, amountMicros, payerEmail);
      if (inserted.changes !== 1) return false; // already credited (webhook and capture can both arrive)
      db.prepare("UPDATE wallets SET balance_micros = balance_micros + ? WHERE id = ?").run(amountMicros, walletId);
      ledger("topup", { wallet_id: walletId, amount_micros: amountMicros, ref: captureId, memo: `PayPal order ${orderId}` });
      return true;
    }),

    async captureTopup(orderId: string, walletId: string) {
      const order = await paypal.captureOrder(orderId);
      const unit = order.purchase_units?.[0];
      const capture = unit?.payments?.captures?.[0];
      if (order.status !== "COMPLETED" || !capture || capture.status !== "COMPLETED") {
        throw new TollError(`Payment not completed (status ${capture?.status ?? order.status})`, 402);
      }
      const owner = unit?.custom_id ?? walletId;
      if (owner !== walletId) throw new TollError("This order belongs to a different wallet", 409);
      const amountMicros = usdToMicros(Number(capture.amount.value));
      const credited = this.creditTopup(capture.id, order.id, owner, amountMicros, order.payer?.email_address ?? null);
      if (credited) emit({ type: "topup", walletId: owner, amountMicros, captureId: capture.id });
      return { captureId: capture.id, amountMicros, credited };
    },

    /** Cash out unused balance: refunds part of an earlier PayPal top-up capture. */
    async withdraw(walletId: string, captureId: string, amountUsd: number) {
      const wallet = q.walletById.get(walletId);
      const topup = db
        .prepare<[string, string], { amount_micros: number; refunded_micros: number }>(
          "SELECT amount_micros, refunded_micros FROM topups WHERE capture_id = ? AND wallet_id = ?",
        )
        .get(captureId, walletId);
      if (!wallet || !topup) throw new TollError("Top-up not found for this wallet", 404);
      const { value, micros } = wholeCents(usdToMicros(amountUsd));
      if (micros <= 0) throw new TollError("Amount must be at least $0.01");
      if (micros > wallet.balance_micros) throw new TollError("Amount is more than the wallet balance");
      if (micros > topup.amount_micros - topup.refunded_micros) throw new TollError("Amount is more than what is left on this top-up");
      // Reserve the money first so concurrent agent payments cannot spend it during the PayPal call.
      db.prepare("UPDATE wallets SET balance_micros = balance_micros - ? WHERE id = ?").run(micros, walletId);
      try {
        const refund = await paypal.refundCapture(captureId, value, "Unused Toll agent balance", `withdraw-${randomUUID()}`);
        db.prepare("UPDATE topups SET refunded_micros = refunded_micros + ? WHERE capture_id = ?").run(micros, captureId);
        ledger("withdrawal", { wallet_id: walletId, amount_micros: micros, ref: refund.id, memo: `PayPal refund of capture ${captureId}` });
        emit({ type: "refund", walletId, amountMicros: micros, ref: refund.id });
        return { refundId: refund.id, status: refund.status, amountMicros: micros };
      } catch (err) {
        db.prepare("UPDATE wallets SET balance_micros = balance_micros + ? WHERE id = ?").run(micros, walletId);
        throw err;
      }
    },

    // ---------- PayPal: merchant settlement ----------

    async settle() {
      const merchants = db.prepare<[], Merchant>("SELECT * FROM merchants WHERE pending_micros >= 10000").all();
      const items = merchants
        .map((m) => ({ m, cents: wholeCents(m.pending_micros) }))
        .filter((x) => x.cents.micros > 0);
      if (!items.length) throw new TollError("Nothing to settle yet: merchants need at least $0.01 earned.");
      // Reserve the amounts before calling PayPal so earnings that arrive during the call are not double-counted.
      const reserve = db.transaction(() => {
        for (const { m, cents } of items) db.prepare("UPDATE merchants SET pending_micros = pending_micros - ? WHERE id = ?").run(cents.micros, m.id);
      });
      const release = db.transaction(() => {
        for (const { m, cents } of items) db.prepare("UPDATE merchants SET pending_micros = pending_micros + ? WHERE id = ?").run(cents.micros, m.id);
      });
      reserve();
      const senderBatchId = `toll-${Date.now()}`;
      let batch: paypal.PayoutBatch;
      try {
        batch = await paypal.createPayout(
          senderBatchId,
          items.map(({ m, cents }) => ({
            receiver: m.paypal_email,
            value: cents.value,
            note: `Earnings from AI agents for ${m.name}`,
            senderItemId: m.id,
          })),
        );
      } catch (err) {
        release();
        throw err;
      }
      const total = items.reduce((s, x) => s + x.cents.micros, 0);
      db.transaction(() => {
        for (const { m, cents } of items) {
          db.prepare("UPDATE merchants SET settled_micros = settled_micros + ? WHERE id = ?").run(cents.micros, m.id);
          ledger("settlement", { merchant_id: m.id, amount_micros: cents.micros, ref: batch.batch_header.payout_batch_id, memo: `PayPal payout to ${m.paypal_email}` });
        }
        db.prepare("INSERT INTO settlements (batch_id, sender_batch_id, status, total_micros, items_json) VALUES (?, ?, ?, ?, ?)").run(
          batch.batch_header.payout_batch_id,
          senderBatchId,
          batch.batch_header.batch_status,
          total,
          JSON.stringify(items.map(({ m, cents }) => ({ merchantId: m.id, merchant: m.name, receiver: m.paypal_email, value: cents.value }))),
        );
      })();
      emit({ type: "settlement", batchId: batch.batch_header.payout_batch_id, status: batch.batch_header.batch_status, totalMicros: total });
      return { batchId: batch.batch_header.payout_batch_id, status: batch.batch_header.batch_status, totalMicros: total, merchants: items.length };
    },

    async refreshSettlement(batchId: string) {
      const batch = await paypal.getPayout(batchId);
      db.prepare("UPDATE settlements SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE batch_id = ?").run(
        batch.batch_header.batch_status,
        batchId,
      );
      emit({ type: "settlement", batchId, status: batch.batch_header.batch_status, totalMicros: 0 });
      return {
        batchId,
        status: batch.batch_header.batch_status,
        items: (batch.items ?? []).map((i) => ({ receiver: i.payout_item.receiver, value: i.payout_item.amount.value, status: i.transaction_status })),
      };
    },

    setSettlementStatus(batchId: string, status: string) {
      db.prepare("UPDATE settlements SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE batch_id = ?").run(status, batchId);
      emit({ type: "settlement", batchId, status, totalMicros: 0 });
    },

    // ---------- Dashboard ----------

    state() {
      const wallets = db.prepare<[], Wallet>("SELECT * FROM wallets ORDER BY created_at").all().map((w) => ({
        id: w.id,
        name: w.name,
        balanceMicros: w.balance_micros,
        balance: formatUsd(w.balance_micros),
        spentTodayMicros: spentToday(w.id),
        rulesText: w.rules_text,
        policy: policyOf(w),
        policyIsDefault: !w.policy_json,
        topups: db
          .prepare<[string], { capture_id: string; amount_micros: number; refunded_micros: number; created_at: string }>(
            "SELECT capture_id, amount_micros, refunded_micros, created_at FROM topups WHERE wallet_id = ? ORDER BY created_at DESC",
          )
          .all(w.id),
      }));
      const merchants = db.prepare<[], Merchant>("SELECT * FROM merchants ORDER BY created_at").all().map((m) => ({
        id: m.id,
        name: m.name,
        url: m.url,
        category: m.category,
        paypalEmail: m.paypal_email,
        pendingMicros: m.pending_micros,
        settledMicros: m.settled_micros,
      }));
      const payments = db.prepare<[], Payment>("SELECT * FROM payments ORDER BY created_at DESC LIMIT 100").all().map(publicPayment);
      const settlements = db
        .prepare<[], { batch_id: string; status: string; total_micros: number; items_json: string; created_at: string }>(
          "SELECT * FROM settlements ORDER BY created_at DESC LIMIT 20",
        )
        .all()
        .map((s) => ({ batchId: s.batch_id, status: s.status, totalMicros: s.total_micros, items: JSON.parse(s.items_json), createdAt: s.created_at }));
      const ledgerRows = db.prepare("SELECT * FROM ledger ORDER BY id DESC LIMIT 100").all();
      return { wallets, merchants, payments, settlements, ledger: ledgerRows, aiEnabled: aiEnabled(), paypalEnabled: paypal.paypalConfigured() };
    },
  };
}

export type Service = ReturnType<typeof createService>;
