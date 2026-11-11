/** All amounts inside Toll are integer micro-dollars: 1 USD = 1_000_000 micros. */
export const MICROS_PER_USD = 1_000_000;

export const usdToMicros = (usd: number) => Math.round(usd * MICROS_PER_USD);
export const microsToUsd = (micros: number) => micros / MICROS_PER_USD;

/** Parses "$0.02", "0.02" or a number of dollars into micros. */
export function parsePrice(price: string | number): number {
  if (typeof price === "number") return usdToMicros(price);
  const n = Number(price.replace(/[$,\s]/g, ""));
  if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid price: ${price}`);
  return usdToMicros(n);
}

/** Human display: shows sub-cent amounts with enough precision. */
export function formatUsd(micros: number): string {
  const usd = microsToUsd(micros);
  if (usd !== 0 && Math.abs(usd) < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/** PayPal only moves whole cents. Returns the whole-cent part (rounded down) as "12.34" and in micros. */
export function wholeCents(micros: number): { value: string; micros: number } {
  const cents = Math.floor(micros / 10_000);
  return { value: (cents / 100).toFixed(2), micros: cents * 10_000 };
}
