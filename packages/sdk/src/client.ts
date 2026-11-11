import {
  NETWORK,
  SCHEME,
  X402_VERSION,
  decodeHeader,
  encodeHeader,
  formatMicros,
  type PaymentRequiredBody,
  type PaymentRequirements,
  type PaymentResponse,
} from "./protocol.ts";

export type TollDecision = {
  id: string;
  status: "approved" | "blocked" | "pending_approval" | "consumed" | "refunded" | "expired";
  amount: string;
  reason: string | null;
  decidedBy: string | null;
  signals: string[];
  token?: string;
};

export type TollFetchResult = {
  response: Response;
  /** Present when the resource cost money. */
  payment?: { requirement: PaymentRequirements; decision: TollDecision; receipt?: PaymentResponse };
};

export type TollClientOptions = {
  gateway: string;
  agentKey: string;
  /** How long to wait for the owner to approve a payment that needs approval. */
  approvalTimeoutMs?: number;
  onEvent?: (msg: string) => void;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * fetch() for agents. If a server answers 402 with a toll-paypal requirement, asks the Toll gateway
 * to pay (the gateway enforces the owner's rules), then retries with the payment token.
 * `purpose` tells the gateway why the agent wants this, so the AI judge can check it against the task.
 */
export function createTollFetch(opts: TollClientOptions) {
  const log = opts.onEvent ?? (() => {});

  async function askGateway(req: PaymentRequirements, purpose: string): Promise<TollDecision> {
    const r = await fetch(`${opts.gateway}/v1/payments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.agentKey}` },
      body: JSON.stringify({
        payTo: req.payTo,
        amountMicros: Number(req.maxAmountRequired),
        resource: req.resource,
        description: `${req.extra?.merchantName ?? ""}: ${req.description}`,
        purpose,
      }),
    });
    const body = (await r.json()) as TollDecision & { error?: string };
    if (!r.ok) throw new Error(body.error ?? `Toll gateway error ${r.status}`);
    return body;
  }

  async function waitForOwner(id: string): Promise<TollDecision> {
    const deadline = Date.now() + (opts.approvalTimeoutMs ?? 90_000);
    log(`Waiting for the owner to approve payment ${id}...`);
    while (Date.now() < deadline) {
      await sleep(1500);
      const r = await fetch(`${opts.gateway}/v1/payments/${id}`, { headers: { Authorization: `Bearer ${opts.agentKey}` } });
      const d = (await r.json()) as TollDecision;
      if (d.status !== "pending_approval") return d;
    }
    return { id, status: "blocked", amount: "", reason: "The owner did not respond in time.", decidedBy: "timeout", signals: [] };
  }

  return async function tollFetch(url: string, purpose: string, init: RequestInit = {}): Promise<TollFetchResult> {
    const first = await fetch(url, init);
    if (first.status !== 402) return { response: first };

    const body = (await first.json().catch(() => null)) as PaymentRequiredBody | null;
    const requirement = body?.accepts?.find((a) => a.scheme === SCHEME);
    if (!requirement) return { response: new Response(JSON.stringify(body), { status: 402 }) };

    log(`402 from ${requirement.extra.merchantName}: ${formatMicros(Number(requirement.maxAmountRequired))} for ${requirement.resource}`);
    let decision = await askGateway(requirement, purpose);
    if (decision.status === "pending_approval") decision = await waitForOwner(decision.id);
    if (decision.status !== "approved" || !decision.token) {
      log(`Toll blocked the payment: ${decision.reason}`);
      return {
        response: new Response(JSON.stringify({ blockedByToll: true, reason: decision.reason }), { status: 402 }),
        payment: { requirement, decision },
      };
    }

    const header = encodeHeader({
      x402Version: X402_VERSION,
      scheme: SCHEME,
      network: NETWORK,
      payload: { token: decision.token, paymentId: decision.id },
    });
    const paid = await fetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), "X-PAYMENT": header } });
    const receiptHeader = paid.headers.get("X-PAYMENT-RESPONSE");
    const receipt = receiptHeader ? decodeHeader<PaymentResponse>(receiptHeader) : undefined;
    log(`Paid ${decision.amount} to ${requirement.extra.merchantName}`);
    return { response: paid, payment: { requirement, decision, receipt } };
  };
}
