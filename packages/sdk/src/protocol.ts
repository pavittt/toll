/**
 * Wire format. Toll follows the shape of the x402 protocol (HTTP 402 + an "accepts" list,
 * an X-PAYMENT request header and an X-PAYMENT-RESPONSE header) with a new scheme,
 * "toll-paypal", whose money moves through PayPal instead of a blockchain.
 */

export const X402_VERSION = 1;
export const SCHEME = "toll-paypal";
export const NETWORK = "paypal-sandbox";

export type PaymentRequirements = {
  scheme: typeof SCHEME;
  network: string;
  /** Price in USD micro-dollars (1 USD = 1,000,000), as a string, like x402 atomic units. */
  maxAmountRequired: string;
  asset: "USD";
  resource: string;
  description: string;
  mimeType: string;
  /** Toll merchant id. */
  payTo: string;
  maxTimeoutSeconds: number;
  extra: { gateway: string; displayPrice: string; merchantName: string; decimals: 6 };
};

export type PaymentRequiredBody = {
  x402Version: number;
  error: string;
  accepts: PaymentRequirements[];
};

export type PaymentPayload = {
  x402Version: number;
  scheme: typeof SCHEME;
  network: string;
  payload: { token: string; paymentId: string };
};

export type PaymentResponse = { success: boolean; transaction: string; network: string };

export const encodeHeader = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");
export const decodeHeader = <T>(v: string): T => JSON.parse(Buffer.from(v, "base64").toString()) as T;

export function formatMicros(micros: number) {
  const usd = micros / 1_000_000;
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

export function parsePriceToMicros(price: string | number): number {
  const n = typeof price === "number" ? price : Number(price.replace(/[$,\s]/g, ""));
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Invalid price: ${price}`);
  return Math.round(n * 1_000_000);
}
