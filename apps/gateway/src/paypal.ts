import { config } from "./config.js";

/** Minimal PayPal REST client (Orders v2, Payments v2 refunds, Payouts v1, webhook verification). */

let cached: { token: string; expiresAt: number } | null = null;

export class PayPalError extends Error {
  constructor(message: string, public status: number, public details: unknown) {
    super(message);
  }
}

export function paypalConfigured() {
  return Boolean(config.paypal.clientId && config.paypal.clientSecret);
}

async function accessToken(): Promise<string> {
  if (!paypalConfigured()) throw new PayPalError("PayPal credentials are not configured", 500, null);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const basic = Buffer.from(`${config.paypal.clientId}:${config.paypal.clientSecret}`).toString("base64");
  const res = await fetch(`${config.paypal.apiBase}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  const body = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!res.ok || !body.access_token) throw new PayPalError("PayPal OAuth failed", res.status, body);
  cached = { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 300) * 1000 };
  return cached.token;
}

async function call<T>(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
  const token = await accessToken();
  const res = await fetch(`${config.paypal.apiBase}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...extraHeaders,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const message = json?.message ?? json?.error_description ?? `PayPal ${method} ${path} failed`;
    throw new PayPalError(message, res.status, json);
  }
  return json as T;
}

type Money = { currency_code: string; value: string };

export type Order = {
  id: string;
  status: string;
  purchase_units?: Array<{
    custom_id?: string;
    payments?: { captures?: Array<{ id: string; status: string; amount: Money }> };
  }>;
  payer?: { email_address?: string };
};

export function createOrder(amountUsd: string, walletId: string, requestId: string) {
  return call<Order>(
    "POST",
    "/v2/checkout/orders",
    {
      intent: "CAPTURE",
      purchase_units: [
        {
          amount: { currency_code: "USD", value: amountUsd },
          custom_id: walletId,
          description: "Toll agent wallet top-up",
          soft_descriptor: "TOLL AGENT",
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: "Toll",
            shipping_preference: "NO_SHIPPING",
            user_action: "PAY_NOW",
          },
        },
      },
    },
    { "PayPal-Request-Id": requestId },
  );
}

export function captureOrder(orderId: string) {
  return call<Order>("POST", `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {}, {
    "PayPal-Request-Id": `capture-${orderId}`,
  });
}

export function getOrder(orderId: string) {
  return call<Order>("GET", `/v2/checkout/orders/${encodeURIComponent(orderId)}`);
}

export function refundCapture(captureId: string, amountUsd: string, note: string, requestId: string) {
  return call<{ id: string; status: string; amount?: Money }>(
    "POST",
    `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`,
    { amount: { currency_code: "USD", value: amountUsd }, note_to_payer: note.slice(0, 255) },
    { "PayPal-Request-Id": requestId },
  );
}

export type PayoutItem = { receiver: string; value: string; note: string; senderItemId: string };

export type PayoutBatch = {
  batch_header: {
    payout_batch_id: string;
    batch_status: string;
    sender_batch_header?: { sender_batch_id: string };
    amount?: { value: string; currency: string };
  };
  items?: Array<{
    payout_item_id: string;
    transaction_status?: string;
    payout_item: { receiver: string; sender_item_id?: string; amount: { value: string } };
  }>;
};

export function createPayout(senderBatchId: string, items: PayoutItem[]) {
  return call<PayoutBatch>("POST", "/v1/payments/payouts", {
    sender_batch_header: {
      sender_batch_id: senderBatchId,
      email_subject: "You earned money from AI agents on Toll",
      email_message: "AI agents paid to use your content or API through Toll.",
    },
    items: items.map((i) => ({
      recipient_type: "EMAIL",
      amount: { value: i.value, currency: "USD" },
      receiver: i.receiver,
      note: i.note.slice(0, 4000),
      sender_item_id: i.senderItemId,
    })),
  });
}

export function getPayout(batchId: string) {
  return call<PayoutBatch>("GET", `/v1/payments/payouts/${encodeURIComponent(batchId)}`);
}

export async function verifyWebhook(headers: Record<string, string | undefined>, event: unknown): Promise<boolean> {
  if (!config.paypal.webhookId) return false;
  const res = await call<{ verification_status: string }>("POST", "/v1/notifications/verify-webhook-signature", {
    auth_algo: headers["paypal-auth-algo"],
    cert_url: headers["paypal-cert-url"],
    transmission_id: headers["paypal-transmission-id"],
    transmission_sig: headers["paypal-transmission-sig"],
    transmission_time: headers["paypal-transmission-time"],
    webhook_id: config.paypal.webhookId,
    webhook_event: event,
  });
  return res.verification_status === "SUCCESS";
}
