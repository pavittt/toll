import type { NextFunction, Request, Response } from "express";
import {
  NETWORK,
  SCHEME,
  X402_VERSION,
  decodeHeader,
  encodeHeader,
  formatMicros,
  parsePriceToMicros,
  type PaymentPayload,
  type PaymentRequiredBody,
} from "./protocol.ts";

export type TollPaywallOptions = {
  /** Toll gateway base URL, e.g. http://localhost:4000 */
  gateway: string;
  merchantId: string;
  merchantKey: string;
  merchantName: string;
  /** "$0.02", "0.02" or 0.02 (dollars). Can be a function of the request for dynamic pricing. */
  price: string | number | ((req: Request) => string | number);
  description: string | ((req: Request) => string);
  mimeType?: string;
};

/** Absolute URL of the request, which a payment token is bound to. */
export const resourceUrl = (req: Request) => `${req.protocol}://${req.get("host")}${req.originalUrl}`;

/**
 * One line to charge AI agents for a route:
 *   app.get("/premium", tollPaywall({ ...keys, price: "$0.02", description: "..." }), handler)
 */
export function tollPaywall(opts: TollPaywallOptions) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const resource = resourceUrl(req);
    const priceMicros = parsePriceToMicros(typeof opts.price === "function" ? opts.price(req) : opts.price);
    const description = typeof opts.description === "function" ? opts.description(req) : opts.description;
    const header = req.header("X-PAYMENT");

    const requirePayment = (error: string) => {
      const body: PaymentRequiredBody = {
        x402Version: X402_VERSION,
        error,
        accepts: [
          {
            scheme: SCHEME,
            network: NETWORK,
            maxAmountRequired: String(priceMicros),
            asset: "USD",
            resource,
            description,
            mimeType: opts.mimeType ?? "application/json",
            payTo: opts.merchantId,
            maxTimeoutSeconds: 300,
            extra: { gateway: opts.gateway, displayPrice: formatMicros(priceMicros), merchantName: opts.merchantName, decimals: 6 },
          },
        ],
      };
      res.status(402).json(body);
    };

    if (!header) return requirePayment("X-PAYMENT header is required");

    let payment: PaymentPayload;
    try {
      payment = decodeHeader<PaymentPayload>(header);
    } catch {
      return requirePayment("Malformed X-PAYMENT header");
    }
    if (payment.scheme !== SCHEME || !payment.payload?.token) return requirePayment("Unsupported payment scheme");

    try {
      const r = await fetch(`${opts.gateway}/v1/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.merchantKey}` },
        body: JSON.stringify({ token: payment.payload.token, resource }),
      });
      const result = (await r.json()) as { valid: boolean; paymentId?: string; amountMicros?: number; error?: string };
      if (!result.valid) return requirePayment(`Payment rejected: ${result.error ?? "unknown"}`);
      if ((result.amountMicros ?? 0) < priceMicros) return requirePayment("Payment amount is below the price");
      res.setHeader("X-PAYMENT-RESPONSE", encodeHeader({ success: true, transaction: result.paymentId, network: NETWORK }));
      res.locals.tollPaymentId = result.paymentId;
      next();
    } catch (err) {
      res.status(502).json({ error: "Could not reach the Toll gateway", detail: String(err) });
    }
  };
}
