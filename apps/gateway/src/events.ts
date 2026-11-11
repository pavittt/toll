import type { Response } from "express";

export type TollEvent =
  | { type: "payment"; payment: Record<string, unknown> }
  | { type: "topup"; walletId: string; amountMicros: number; captureId: string }
  | { type: "settlement"; batchId: string; status: string; totalMicros: number }
  | { type: "refund"; walletId: string; amountMicros: number; ref: string }
  | { type: "state"; reason: string };

const clients = new Set<Response>();

export function subscribe(res: Response) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  res.write(": connected\n\n");
  clients.add(res);
  const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
  res.on("close", () => {
    clearInterval(ping);
    clients.delete(res);
  });
}

export function emit(event: TollEvent) {
  const data = `data: ${JSON.stringify({ ...event, ts: new Date().toISOString() })}\n\n`;
  for (const c of clients) c.write(data);
}
