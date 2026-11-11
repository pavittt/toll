import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";

/** A payment token is proof that the gateway approved one specific charge. Single use, short-lived. */
export type TokenClaims = {
  pid: string; // payment id
  mid: string; // merchant id
  amt: number; // micros
  res: string; // resource URL
  exp: number; // unix seconds
};

const sign = (payload: string) => createHmac("sha256", config.secret).update(payload).digest("base64url");

export function issueToken(claims: TokenClaims): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function readToken(token: string): TokenClaims | null {
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as TokenClaims;
    if (claims.exp < Date.now() / 1000) return null;
    return claims;
  } catch {
    return null;
  }
}
