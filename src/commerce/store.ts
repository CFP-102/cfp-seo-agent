import type { DatabaseSync } from "node:sqlite";
import { DEFAULT_MARKUP_BPS, MAX_MARKUP_BPS, QUOTE_RETENTION_MS } from "../config/commerce.js";

/**
 * Commerce ledger in the same SQLite database as the request ledger (separate tables, nothing shared or changed there).
 * Money columns are INTEGER micro-units (exact). Stored per order: product, face value, prices, payer wallet address,
 * tx hash, the gift card code ENCRYPTED (see vault.ts) and a hash of the order token. Not stored: IP addresses,
 * headers, payment signatures, plain codes.
 */
export type OrderStatus = "payment_pending" | "paid" | "delivered" | "refund_pending" | "refunded" | "settlement_uncertain";

export interface QuoteRow {
  id: string;
  created_at: string;
  expires_at: string;
  product_id: string;
  face_value: string;
  currency: string;
  cost_micro: number;
  markup_micro: number;
  payment_fee_micro: number;
  sale_micro: number;
  markup_bps: number;
  status: "open" | "used";
}

export interface OrderRow {
  id: string;
  quote_id: string;
  created_at: string;
  updated_at: string;
  status: OrderStatus;
  data_source: "mock" | "live";
  product_id: string;
  face_value: string;
  currency: string;
  cost_micro: number;
  markup_micro: number;
  payment_fee_micro: number;
  sale_micro: number;
  network: string | null;
  payer: string | null;
  payment_key: string | null;
  payment_nonce: string | null;
  settlement_started: number;
  tx_hash: string | null;
  provider_order_id: string | null;
  code_sealed: string | null;
  token_hash: string;
  attempts: number;
  error_code: string | null;
  refund_tx: string | null;
}

export type ClaimResult = { ok: true } | { ok: false; reason: "quote_not_open" | "quote_expired" | "daily_limit" | "payer_limit" | "duplicate_payment" };

const now = () => new Date().toISOString();
const dayStart = () => `${now().slice(0, 10)}T00:00`;

export class CommerceStore {
  constructor(readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS gc_quotes (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        product_id TEXT NOT NULL,
        face_value TEXT NOT NULL,
        currency TEXT NOT NULL,
        cost_micro INTEGER NOT NULL,
        markup_micro INTEGER NOT NULL,
        payment_fee_micro INTEGER NOT NULL,
        sale_micro INTEGER NOT NULL,
        markup_bps INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'open'
      );
      CREATE TABLE IF NOT EXISTS gc_orders (
        id TEXT PRIMARY KEY,
        quote_id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        status TEXT NOT NULL,
        data_source TEXT NOT NULL,
        product_id TEXT NOT NULL,
        face_value TEXT NOT NULL,
        currency TEXT NOT NULL,
        cost_micro INTEGER NOT NULL,
        markup_micro INTEGER NOT NULL,
        payment_fee_micro INTEGER NOT NULL,
        sale_micro INTEGER NOT NULL,
        network TEXT,
        payer TEXT,
        payment_key TEXT UNIQUE,
        payment_nonce TEXT,
        settlement_started INTEGER NOT NULL DEFAULT 0,
        tx_hash TEXT,
        provider_order_id TEXT,
        code_sealed TEXT,
        token_hash TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        error_code TEXT,
        refund_tx TEXT
      );
      CREATE INDEX IF NOT EXISTS gc_orders_created ON gc_orders(created_at);
      CREATE TABLE IF NOT EXISTS commerce_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS commerce_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        detail TEXT NOT NULL
      );
    `);
  }

  // ---------- settings (markup, kill switch) ----------
  markupBps(): number {
    const row = this.db.prepare(`SELECT value FROM commerce_settings WHERE key='markup_bps'`).get() as { value: string } | undefined;
    const v = row ? Number(row.value) : DEFAULT_MARKUP_BPS;
    return Number.isInteger(v) && v >= 0 && v <= MAX_MARKUP_BPS ? v : DEFAULT_MARKUP_BPS;
  }

  paused(): boolean {
    const row = this.db.prepare(`SELECT value FROM commerce_settings WHERE key='paused'`).get() as { value: string } | undefined;
    return row?.value === "1";
  }

  setSetting(key: "markup_bps" | "paused", value: string, actor: string): void {
    this.db.prepare(`INSERT INTO commerce_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, value);
    this.audit(actor, `set_${key}`, value);
  }

  audit(actor: string, action: string, detail: string): void {
    this.db.prepare(`INSERT INTO commerce_audit (created_at, actor, action, detail) VALUES (?, ?, ?, ?)`).run(now(), actor.slice(0, 40), action.slice(0, 60), detail.slice(0, 300));
  }

  auditLog(limit = 50) {
    return this.db.prepare(`SELECT created_at, actor, action, detail FROM commerce_audit ORDER BY id DESC LIMIT ?`).all(limit) as { created_at: string; actor: string; action: string; detail: string }[];
  }

  // ---------- quotes ----------
  addQuote(q: Omit<QuoteRow, "created_at" | "status">): void {
    this.db
      .prepare(`INSERT INTO gc_quotes (id, created_at, expires_at, product_id, face_value, currency, cost_micro, markup_micro, payment_fee_micro, sale_micro, markup_bps) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(q.id, now(), q.expires_at, q.product_id, q.face_value, q.currency, q.cost_micro, q.markup_micro, q.payment_fee_micro, q.sale_micro, q.markup_bps);
  }

  quote(id: string): QuoteRow | undefined {
    return this.db.prepare(`SELECT * FROM gc_quotes WHERE id=?`).get(id) as QuoteRow | undefined;
  }

  /**
   * Sum of today's (UTC) orders that count against the daily limit, in micro-USD: settled ones and those in flight.
   * Rejected or unconfirmed settlements do not count, so worthless payment attempts cannot use up the limit for others.
   */
  volumeToday(): number {
    return (this.db.prepare(`SELECT COALESCE(SUM(sale_micro), 0) AS s FROM gc_orders WHERE created_at >= ? AND status != 'refunded' AND (tx_hash IS NOT NULL OR status IN ('payment_pending', 'paid'))`).get(dayStart()) as { s: number }).s;
  }

  // ---------- orders ----------
  /**
   * Atomically turn an open quote into an order. One transaction checks the quote, the daily volume and the payer's
   * daily order count, inserts the order and marks the quote used. UNIQUE(quote_id) and UNIQUE(payment_key) make a
   * second order for the same quote or the same payment impossible, even under concurrency.
   */
  claimOrder(o: Pick<OrderRow, "id" | "quote_id" | "data_source" | "network" | "payer" | "payment_key" | "payment_nonce" | "token_hash">, limits: { dailyMicro: number; payerDailyOrders: number }): ClaimResult {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const q = this.quote(o.quote_id);
      const fail = (reason: Extract<ClaimResult, { ok: false }>["reason"]): ClaimResult => {
        this.db.exec("ROLLBACK");
        return { ok: false, reason };
      };
      if (!q || q.status !== "open") return fail("quote_not_open");
      if (Date.parse(q.expires_at) <= Date.now()) return fail("quote_expired");
      if (this.volumeToday() + q.sale_micro > limits.dailyMicro) return fail("daily_limit");
      if (o.payer) {
        const n = (this.db.prepare(`SELECT COUNT(*) AS n FROM gc_orders WHERE created_at >= ? AND payer=?`).get(dayStart(), o.payer) as { n: number }).n;
        if (n >= limits.payerDailyOrders) return fail("payer_limit");
      }
      if (o.payment_key && this.byPaymentKey(o.payment_key)) return fail("duplicate_payment");
      const t = now();
      this.db
        .prepare(
          `INSERT INTO gc_orders (id, quote_id, created_at, updated_at, status, data_source, product_id, face_value, currency, cost_micro, markup_micro, payment_fee_micro, sale_micro, network, payer, payment_key, payment_nonce, token_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(o.id, q.id, t, t, o.payment_key ? "payment_pending" : "paid", o.data_source, q.product_id, q.face_value, q.currency, q.cost_micro, q.markup_micro, q.payment_fee_micro, q.sale_micro, o.network, o.payer, o.payment_key, o.payment_nonce, o.token_hash);
      this.db.prepare(`UPDATE gc_quotes SET status='used' WHERE id=?`).run(q.id);
      this.db.exec("COMMIT");
      return { ok: true };
    } catch (err) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw err;
    }
  }

  order(id: string): OrderRow | undefined {
    return this.db.prepare(`SELECT * FROM gc_orders WHERE id=?`).get(id) as OrderRow | undefined;
  }

  orderForQuote(quoteId: string): OrderRow | undefined {
    return this.db.prepare(`SELECT * FROM gc_orders WHERE quote_id=?`).get(quoteId) as OrderRow | undefined;
  }

  byPaymentKey(key: string): OrderRow | undefined {
    return this.db.prepare(`SELECT * FROM gc_orders WHERE payment_key=?`).get(key) as OrderRow | undefined;
  }

  private move(id: string, from: OrderStatus[], set: string, ...args: (string | number | null)[]): boolean {
    const r = this.db.prepare(`UPDATE gc_orders SET ${set}, updated_at=? WHERE id=? AND status IN (${from.map(() => "?").join(",")})`).run(...args, now(), id, ...from);
    return Number(r.changes) === 1;
  }

  /** Settlement is about to be attempted (x402 onBeforeSettle). Only once per payment. */
  startSettlement(paymentKey: string): boolean {
    return Number(this.db.prepare(`UPDATE gc_orders SET settlement_started=1, updated_at=? WHERE payment_key=? AND status='payment_pending' AND settlement_started=0`).run(now(), paymentKey).changes) === 1;
  }

  setSettled(id: string, txHash: string, payer: string | null): boolean {
    return this.move(id, ["payment_pending", "settlement_uncertain"], "status='paid', tx_hash=?, payer=COALESCE(?, payer)", txHash, payer);
  }

  delivered(id: string, providerOrderId: string, codeSealed: string): boolean {
    return this.move(id, ["paid"], "status='delivered', provider_order_id=?, code_sealed=?, error_code=NULL, attempts=attempts+1", providerOrderId, codeSealed);
  }

  deliveryFailed(id: string, errorCode: string): boolean {
    return this.move(id, ["paid"], "status='refund_pending', error_code=?, attempts=attempts+1", errorCode);
  }

  /** Admin: try the delivery again (same idempotency key at the supplier, so never a second card). */
  beginRedelivery(id: string): boolean {
    return this.move(id, ["refund_pending"], "status='paid'");
  }

  /** Admin: the payment was refunded on-chain (tx of the refund transfer). */
  refunded(id: string, refundTx: string): boolean {
    return this.move(id, ["refund_pending", "settlement_uncertain"], "status='refunded', refund_tx=?", refundTx);
  }

  uncertain(id: string): boolean {
    return this.move(id, ["payment_pending"], "status='settlement_uncertain', error_code='settlement_uncertain'");
  }

  /** Drop an order whose payment was never attempted and reopen its quote (nothing was charged). */
  release(id: string): void {
    const row = this.order(id);
    if (!row || row.status !== "payment_pending" || row.settlement_started || row.tx_hash) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`DELETE FROM gc_orders WHERE id=? AND status='payment_pending' AND settlement_started=0 AND tx_hash IS NULL`).run(id);
      this.db.prepare(`UPDATE gc_quotes SET status='open' WHERE id=?`).run(row.quote_id);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** At startup: orders cut off by a restart are kept and flagged, never silently dropped or re-bought. */
  recoverAfterRestart(): { uncertain: number; undelivered: number } {
    const t = now();
    const uncertain = this.db.prepare(`UPDATE gc_orders SET status='settlement_uncertain', error_code='interrupted', updated_at=? WHERE status='payment_pending' AND settlement_started=1`).run(t);
    // Never attempted: nothing was charged. Reopen the quote (it may still be valid) and drop the order.
    this.db.prepare(`UPDATE gc_quotes SET status='open' WHERE id IN (SELECT quote_id FROM gc_orders WHERE status='payment_pending' AND settlement_started=0 AND tx_hash IS NULL)`).run();
    this.db.prepare(`DELETE FROM gc_orders WHERE status='payment_pending' AND settlement_started=0 AND tx_hash IS NULL`).run();
    const undelivered = this.db.prepare(`UPDATE gc_orders SET status='refund_pending', error_code='interrupted', updated_at=? WHERE status='paid'`).run(t);
    return { uncertain: Number(uncertain.changes), undelivered: Number(undelivered.changes) };
  }

  /** Data minimization: codes are deleted after the retention period, unused quotes after a day. */
  purge(retentionDays: number, at: Date = new Date()): number {
    const cutoff = new Date(at.getTime() - retentionDays * 86_400_000).toISOString();
    this.db.prepare(`DELETE FROM gc_quotes WHERE created_at < ? AND status='open'`).run(new Date(at.getTime() - QUOTE_RETENTION_MS).toISOString());
    this.db.prepare(`DELETE FROM gc_quotes WHERE created_at < ?`).run(cutoff);
    return Number(this.db.prepare(`UPDATE gc_orders SET code_sealed=NULL WHERE created_at < ? AND code_sealed IS NOT NULL`).run(cutoff).changes);
  }

  // ---------- dashboard ----------
  stats(since: string) {
    const totals = this.db
      .prepare(
        `SELECT COUNT(*) AS orders,
                COALESCE(SUM(CASE WHEN tx_hash IS NOT NULL THEN 1 ELSE 0 END), 0) AS paid,
                COALESCE(SUM(CASE WHEN tx_hash IS NOT NULL THEN sale_micro ELSE 0 END), 0) AS volume_micro,
                COALESCE(SUM(CASE WHEN status='delivered' THEN cost_micro ELSE 0 END), 0) AS cost_micro,
                COALESCE(SUM(CASE WHEN status='delivered' THEN markup_micro ELSE 0 END), 0) AS markup_micro,
                COALESCE(SUM(CASE WHEN status='delivered' THEN sale_micro - cost_micro - payment_fee_micro ELSE 0 END), 0) AS contribution_micro,
                COALESCE(SUM(CASE WHEN status='delivered' THEN 1 ELSE 0 END), 0) AS delivered,
                COALESCE(SUM(CASE WHEN status IN ('payment_pending','paid') THEN 1 ELSE 0 END), 0) AS open,
                COALESCE(SUM(CASE WHEN status='settlement_uncertain' THEN 1 ELSE 0 END), 0) AS uncertain,
                COALESCE(SUM(CASE WHEN status='refund_pending' THEN 1 ELSE 0 END), 0) AS refund_pending,
                COALESCE(SUM(CASE WHEN status='refunded' THEN 1 ELSE 0 END), 0) AS refunded
         FROM gc_orders WHERE created_at >= ?`,
      )
      .get(since) as Record<string, number>;
    return totals;
  }

  /** Latest orders for the dashboard. Never includes the sealed code or the token hash. */
  recentOrders(limit = 30) {
    return this.db
      .prepare(
        `SELECT id, created_at, status, data_source, product_id, face_value, currency, cost_micro, markup_micro, payment_fee_micro, sale_micro, network, payer, tx_hash, attempts, error_code, refund_tx
         FROM gc_orders ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit) as unknown as Omit<OrderRow, "code_sealed" | "token_hash" | "payment_key" | "payment_nonce" | "quote_id" | "updated_at" | "settlement_started" | "provider_order_id">[];
  }
}
