import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { config } from "./config.js";

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
  agent_key: string;
  balance_micros: number;
  rules_text: string;
  policy_json: string | null;
  created_at: string;
};

export type Merchant = {
  id: string;
  name: string;
  url: string;
  category: string;
  paypal_email: string;
  merchant_key: string;
  pending_micros: number;
  settled_micros: number;
  created_at: string;
};

export type Payment = {
  id: string;
  wallet_id: string;
  merchant_id: string;
  amount_micros: number;
  resource: string;
  description: string;
  purpose: string;
  status: "approved" | "blocked" | "pending_approval" | "consumed" | "refunded" | "expired";
  decision_by: string | null;
  reason: string | null;
  signals_json: string | null;
  created_at: string;
  consumed_at: string | null;
};

export type LedgerEntry = {
  id: number;
  ts: string;
  kind: "topup" | "charge" | "blocked" | "settlement" | "refund" | "withdrawal";
  wallet_id: string | null;
  merchant_id: string | null;
  amount_micros: number;
  ref: string | null;
  memo: string | null;
};

export function openDb(path = config.dbPath) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS wallets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      agent_key TEXT NOT NULL UNIQUE,
      balance_micros INTEGER NOT NULL DEFAULT 0 CHECK (balance_micros >= 0),
      rules_text TEXT NOT NULL DEFAULT '',
      policy_json TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS merchants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      category TEXT NOT NULL,
      paypal_email TEXT NOT NULL,
      merchant_key TEXT NOT NULL UNIQUE,
      pending_micros INTEGER NOT NULL DEFAULT 0,
      settled_micros INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      wallet_id TEXT NOT NULL REFERENCES wallets(id),
      merchant_id TEXT NOT NULL REFERENCES merchants(id),
      amount_micros INTEGER NOT NULL,
      resource TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      purpose TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      decision_by TEXT,
      reason TEXT,
      signals_json TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      consumed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS payments_wallet_time ON payments(wallet_id, created_at);
    CREATE TABLE IF NOT EXISTS topups (
      capture_id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      wallet_id TEXT NOT NULL REFERENCES wallets(id),
      amount_micros INTEGER NOT NULL,
      refunded_micros INTEGER NOT NULL DEFAULT 0,
      payer_email TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS settlements (
      batch_id TEXT PRIMARY KEY,
      sender_batch_id TEXT NOT NULL,
      status TEXT NOT NULL,
      total_micros INTEGER NOT NULL,
      items_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      kind TEXT NOT NULL,
      wallet_id TEXT,
      merchant_id TEXT,
      amount_micros INTEGER NOT NULL,
      ref TEXT,
      memo TEXT
    );
    CREATE TABLE IF NOT EXISTS webhook_events (
      id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);
  return db;
}

export type DB = ReturnType<typeof openDb>;

export const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
export const newKey = (prefix: string) => `${prefix}_${randomBytes(24).toString("base64url")}`;
