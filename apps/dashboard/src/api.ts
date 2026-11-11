export const GATEWAY = import.meta.env.VITE_GATEWAY_URL ?? "http://localhost:4000";
export const AGENT = import.meta.env.VITE_AGENT_URL ?? "http://localhost:4100";

export type Policy = {
  dailyLimitUsd: number;
  perPaymentMaxUsd: number;
  requireApprovalAboveUsd: number | null;
  allowedCategories: string[];
  blockedCategories: string[];
  blockedMerchants: string[];
  notes: string;
};

export type Wallet = {
  id: string;
  name: string;
  balanceMicros: number;
  balance: string;
  spentTodayMicros: number;
  rulesText: string;
  policy: Policy;
  policyIsDefault: boolean;
  topups: Array<{ capture_id: string; amount_micros: number; refunded_micros: number; created_at: string }>;
};

export type Merchant = {
  id: string;
  name: string;
  url: string;
  category: string;
  paypalEmail: string;
  pendingMicros: number;
  settledMicros: number;
};

export type Payment = {
  id: string;
  walletId: string;
  merchantId: string;
  merchantName?: string;
  amountMicros: number;
  amount: string;
  resource: string;
  purpose: string;
  status: "approved" | "blocked" | "pending_approval" | "consumed" | "refunded" | "expired";
  decidedBy: string | null;
  reason: string | null;
  signals: string[];
  createdAt: string;
};

export type Settlement = {
  batchId: string;
  status: string;
  totalMicros: number;
  items: Array<{ merchant: string; receiver: string; value: string }>;
  createdAt: string;
};

export type State = {
  wallets: Wallet[];
  merchants: Merchant[];
  payments: Payment[];
  settlements: Settlement[];
  aiEnabled: boolean;
  paypalEnabled: boolean;
};

export type TollEvent =
  | { type: "payment"; payment: Payment; ts: string }
  | { type: "topup"; walletId: string; amountMicros: number; captureId: string; ts: string }
  | { type: "settlement"; batchId: string; status: string; totalMicros: number; ts: string }
  | { type: "refund"; walletId: string; amountMicros: number; ref: string; ts: string }
  | { type: "state"; reason: string; ts: string };

export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(`${GATEWAY}${path}`, {
    method: init?.method ?? (init?.body ? "POST" : "GET"),
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body as T;
}

export const usd = (micros: number) => {
  const v = micros / 1_000_000;
  return v !== 0 && Math.abs(v) < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`;
};
