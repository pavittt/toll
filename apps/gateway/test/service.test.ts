import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "../src/db.js";
import { createService } from "../src/service.js";
import type { Decision } from "../src/policy.js";

function setup(judgeDecision: Decision["decision"] = "approve") {
  const db = openDb(":memory:");
  const judgeCalls: string[] = [];
  const service = createService(db, {
    aiEnabled: () => true,
    judge: async (_policy, _rules, req) => {
      judgeCalls.push(req.resource);
      return { decision: judgeDecision, reason: `judge said ${judgeDecision}`, decidedBy: "ai_judge", signals: judgeDecision === "block" ? ["off_task"] : [] };
    },
    compile: async () => ({
      dailyLimitUsd: 1,
      perPaymentMaxUsd: 0.25,
      requireApprovalAboveUsd: 0.1,
      allowedCategories: ["news", "research"],
      blockedCategories: ["gift cards"],
      blockedMerchants: [],
      notes: "",
    }),
  });
  const wallet = service.createWallet("Test agent");
  const news = service.createMerchant({ name: "News", url: "http://news.test", category: "news", paypalEmail: "n@example.com" });
  const shop = service.createMerchant({ name: "Shady", url: "http://shady.test", category: "shopping", paypalEmail: "s@example.com" });
  // Simulates a completed PayPal capture of $5.
  service.creditTopup("CAP-1", "ORDER-1", wallet.id, 5_000_000, null);
  return { db, service, wallet, news, shop, judgeCalls };
}

test("approved payment debits the wallet, credits the merchant and the token works exactly once", async () => {
  const { service, wallet, news } = setup();
  await service.setRules(wallet.id, "rules");
  const r = await service.requestPayment(wallet.agentKey, { payTo: news.id, amount: "$0.02", resource: "http://news.test/a", purpose: "task" });
  assert.equal(r.status, "approved");
  assert.ok(r.token);
  const s = service.state();
  assert.equal(s.wallets[0].balanceMicros, 4_980_000);
  assert.equal(s.merchants[0].pendingMicros, 20_000);

  const first = service.verifyToken(news.merchantKey, r.token!, "http://news.test/a");
  assert.equal(first.valid, true);
  const replay = service.verifyToken(news.merchantKey, r.token!, "http://news.test/a");
  assert.deepEqual(replay, { valid: false, error: "token_already_used" });
});

test("token cannot be used for a different resource or merchant", async () => {
  const { service, wallet, news, shop } = setup();
  const r = await service.requestPayment(wallet.agentKey, { payTo: news.id, amount: 0.02, resource: "http://news.test/a", purpose: "t" });
  assert.equal(service.verifyToken(news.merchantKey, r.token!, "http://news.test/other").valid, false);
  assert.equal(service.verifyToken(shop.merchantKey, r.token!, "http://news.test/a").valid, false);
});

test("hard limits block before the AI judge is ever asked", async () => {
  const { service, wallet, shop, news, judgeCalls } = setup();
  await service.setRules(wallet.id, "rules");
  const big = await service.requestPayment(wallet.agentKey, { payTo: news.id, amount: "$499", resource: "http://news.test/x", purpose: "t" });
  assert.equal(big.status, "blocked");
  assert.equal(big.decidedBy, "rules");
  const wrongCategory = await service.requestPayment(wallet.agentKey, { payTo: shop.id, amount: "$0.05", resource: "http://shady.test/x", purpose: "t" });
  assert.equal(wrongCategory.status, "blocked");
  assert.equal(judgeCalls.length, 0);
  assert.equal(service.state().wallets[0].balanceMicros, 5_000_000);
});

test("daily limit counts earlier spending", async () => {
  const { service, wallet, news } = setup();
  await service.setRules(wallet.id, "rules"); // $1/day, $0.25 max, ask above $0.10
  for (let i = 0; i < 10; i++) {
    const r = await service.requestPayment(wallet.agentKey, { payTo: news.id, amount: "$0.10", resource: `http://news.test/${i}`, purpose: `t${i}` });
    assert.equal(r.status, "approved", `payment ${i}`);
  }
  const over = await service.requestPayment(wallet.agentKey, { payTo: news.id, amount: "$0.05", resource: "http://news.test/11", purpose: "t11" });
  assert.equal(over.status, "blocked");
  assert.match(over.reason ?? "", /daily limit/);
});

test("AI judge can block a payment that is within limits", async () => {
  const { service, wallet, news } = setup("block");
  const r = await service.requestPayment(wallet.agentKey, { payTo: news.id, amount: "$0.05", resource: "http://news.test/a", purpose: "t" });
  assert.equal(r.status, "blocked");
  assert.equal(r.decidedBy, "ai_judge");
  assert.deepEqual(r.signals, ["off_task"]);
});

test("payments over the approval threshold wait for the owner, then charge on approval", async () => {
  const { service, wallet, news } = setup();
  await service.setRules(wallet.id, "rules");
  const r = await service.requestPayment(wallet.agentKey, { payTo: news.id, amount: "$0.20", resource: "http://news.test/bundle", purpose: "t" });
  assert.equal(r.status, "pending_approval");
  assert.equal(service.state().wallets[0].balanceMicros, 5_000_000);
  service.resolveApproval(r.id, true);
  const polled = service.getPaymentForAgent(wallet.agentKey, r.id);
  assert.equal(polled.status, "approved");
  assert.ok(polled.token);
  assert.equal(service.state().wallets[0].balanceMicros, 4_800_000);
});

test("merchant refund returns money to the wallet", async () => {
  const { service, wallet, news } = setup();
  const r = await service.requestPayment(wallet.agentKey, { payTo: news.id, amount: "$0.05", resource: "http://news.test/a", purpose: "t" });
  service.refundPayment(r.id, news.merchantKey);
  const s = service.state();
  assert.equal(s.wallets[0].balanceMicros, 5_000_000);
  assert.equal(s.merchants[0].pendingMicros, 0);
});

test("a PayPal capture is credited only once even if the webhook and capture both arrive", () => {
  const { service, wallet } = setup();
  assert.equal(service.creditTopup("CAP-1", "ORDER-1", wallet.id, 5_000_000, null), false);
  assert.equal(service.state().wallets[0].balanceMicros, 5_000_000);
});

test("unknown agent key is rejected", async () => {
  const { service, news } = setup();
  await assert.rejects(() => service.requestPayment("nope", { payTo: news.id, amount: 0.01, resource: "x" }), /Unknown agent key/);
});
