import { useEffect, useRef, useState } from "react";
import { api, GATEWAY } from "./api";

declare global {
  interface Window {
    paypal?: {
      Buttons: (opts: Record<string, unknown>) => { render: (el: HTMLElement) => Promise<void>; close?: () => void };
    };
  }
}

let sdkPromise: Promise<void> | null = null;
function loadPayPal(clientId: string) {
  sdkPromise ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(clientId)}&currency=USD&intent=capture&components=buttons`;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Could not load the PayPal SDK"));
    document.head.appendChild(s);
  });
  return sdkPromise;
}

export function PayPalTopUp({ walletId, onDone }: { walletId: string; onDone: (msg: string) => void }) {
  const [amount, setAmount] = useState(10);
  const amountRef = useRef(amount);
  amountRef.current = amount;
  const box = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`${GATEWAY}/api/config`)
      .then((r) => r.json())
      .then(async (cfg: { paypalClientId: string }) => {
        if (!cfg.paypalClientId) throw new Error("Set PAYPAL_CLIENT_ID on the gateway to enable top-ups.");
        await loadPayPal(cfg.paypalClientId);
        if (cancelled || !box.current || !window.paypal) return;
        box.current.innerHTML = "";
        await window.paypal
          .Buttons({
            style: { layout: "horizontal", color: "gold", shape: "pill", label: "paypal", height: 40, tagline: false },
            createOrder: async () => {
              const r = await api<{ orderId: string }>(`/api/wallets/${walletId}/topup/orders`, { body: { amountUsd: amountRef.current } });
              return r.orderId;
            },
            onApprove: async (data: { orderID: string }) => {
              const r = await api<{ amountMicros: number }>(`/api/wallets/${walletId}/topup/orders/${data.orderID}/capture`, { body: {} });
              onDone(`Added $${(r.amountMicros / 1e6).toFixed(2)} from PayPal`);
            },
            onError: (err: unknown) => setError(err instanceof Error ? err.message : "PayPal checkout failed"),
          })
          .render(box.current);
      })
      .catch((e: Error) => setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [walletId, onDone]);

  return (
    <div className="topup">
      <div className="amounts">
        {[5, 10, 25].map((a) => (
          <button key={a} className={a === amount ? "chip active" : "chip"} onClick={() => setAmount(a)}>
            ${a}
          </button>
        ))}
      </div>
      <div ref={box} className="pp-box" />
      {error && <p className="error">{error}</p>}
    </div>
  );
}
