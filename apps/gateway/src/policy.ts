import type { Merchant, Policy, Wallet } from "./db.js";
import { formatUsd, usdToMicros } from "./money.js";

export type PaymentRequest = {
  amountMicros: number;
  merchant: Merchant;
  resource: string;
  description: string;
  purpose: string;
};

export type Decision = {
  decision: "approve" | "block" | "ask_owner";
  reason: string;
  decidedBy: "rules" | "ai_judge" | "owner" | "cache";
  signals: string[];
};

export const DEFAULT_POLICY: Policy = {
  dailyLimitUsd: 5,
  perPaymentMaxUsd: 1,
  requireApprovalAboveUsd: 0.5,
  allowedCategories: [],
  blockedCategories: ["gift cards", "gambling", "crypto"],
  blockedMerchants: [],
  notes: "Default guardrails: $5 a day, $1 per payment, ask above $0.50.",
};

const norm = (s: string) => s.trim().toLowerCase();

/**
 * Deterministic guardrails. These run before any AI and cannot be talked out of a decision
 * by text in a web page, so a prompt-injected agent can never exceed the hard limits.
 */
export function hardChecks(
  policy: Policy,
  wallet: Wallet,
  req: PaymentRequest,
  spentTodayMicros: number,
): Decision | null {
  const signals: string[] = [];
  const block = (reason: string): Decision => ({ decision: "block", reason, decidedBy: "rules", signals });

  if (req.amountMicros <= 0) return block("Invalid amount.");
  if (req.amountMicros > usdToMicros(policy.perPaymentMaxUsd)) {
    signals.push("over_per_payment_limit");
    return block(
      `${formatUsd(req.amountMicros)} is over the ${formatUsd(usdToMicros(policy.perPaymentMaxUsd))} per-payment limit.`,
    );
  }
  if (spentTodayMicros + req.amountMicros > usdToMicros(policy.dailyLimitUsd)) {
    signals.push("over_daily_limit");
    return block(
      `This would bring today's spend to ${formatUsd(spentTodayMicros + req.amountMicros)}, over the ${formatUsd(
        usdToMicros(policy.dailyLimitUsd),
      )} daily limit.`,
    );
  }
  const category = norm(req.merchant.category);
  if (policy.blockedCategories.map(norm).includes(category)) {
    signals.push("blocked_category");
    return block(`Merchant category "${req.merchant.category}" is blocked by your rules.`);
  }
  const blockedNames = policy.blockedMerchants.map(norm);
  if (blockedNames.includes(norm(req.merchant.name)) || blockedNames.includes(norm(new URL(req.merchant.url).host))) {
    signals.push("blocked_merchant");
    return block(`${req.merchant.name} is on your blocked list.`);
  }
  if (policy.allowedCategories.length > 0 && !policy.allowedCategories.map(norm).includes(category)) {
    signals.push("category_not_allowed");
    return block(`Merchant category "${req.merchant.category}" is not in your allowed list.`);
  }
  if (req.amountMicros > wallet.balance_micros) {
    signals.push("insufficient_funds");
    return block(`Wallet balance ${formatUsd(wallet.balance_micros)} is less than ${formatUsd(req.amountMicros)}.`);
  }
  return null;
}

export function needsOwnerApproval(policy: Policy, amountMicros: number) {
  return policy.requireApprovalAboveUsd !== null && amountMicros > usdToMicros(policy.requireApprovalAboveUsd);
}
