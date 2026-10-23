import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Request ledger. One row per accepted API call (paid or sandbox).
 * Holds just enough to: serve paid results again, block payment replays,
 * retry a paid call whose upstream failed, and compute revenue/cost statistics.
 * Stored: normalized service input (keywords/domains), payer wallet address,
 * tx hash. Not stored: IP addresses, headers, raw payment signatures.
 */
export type RequestStatus = "processing" | "completed" | "failed";

export interface RequestRow {
  id: string;
  service_id: string;
  created_at: string;
  status: RequestStatus;
  data_source: "sandbox" | "live";
  price_usdc: number;
  payment_key: string | null;
  network: string | null;
  payer: string | null;
  tx_hash: string | null;
  input_hash: string | null;
  input_json: string | null;
  upstream_cost_usd: number;
  cache_hit: number;
  retries: number;
  result_token_hash: string | null;
  result_json: string | null;
  error_code: string | null;
  payment_nonce: string | null;
  payment_asset: string | null;
  payment_to: string | null;
  payment_amount: string | null;
  payment_valid_before: string | null;
  settlement_started: number;
  reconciliation_cursor: string | null;
  reconciliation_checked_at: string | null;
}

export type ClaimRow = Pick<
  RequestRow,
  "id" | "service_id" | "data_source" | "price_usdc" | "payment_key" | "network" | "payer" | "input_hash" | "input_json" | "result_token_hash"
>;

export interface NetworkRow {
  network: string;
  data_source: string;
  requests: number;
  paid: number;
  revenue_usdc: number;
  upstream_cost_usd: number;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY,
        service_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        status TEXT NOT NULL,
        data_source TEXT NOT NULL,
        price_usdc REAL NOT NULL DEFAULT 0,
        payment_key TEXT UNIQUE,
        network TEXT,
        payer TEXT,
        tx_hash TEXT,
        input_hash TEXT,
        input_json TEXT,
        upstream_cost_usd REAL NOT NULL DEFAULT 0,
        cache_hit INTEGER NOT NULL DEFAULT 0,
        retries INTEGER NOT NULL DEFAULT 0,
        result_token_hash TEXT,
        result_json TEXT,
        error_code TEXT
      );
      CREATE INDEX IF NOT EXISTS requests_created ON requests(created_at);
      CREATE TABLE IF NOT EXISTS heartbeats (
        minute TEXT PRIMARY KEY
      );
      CREATE TABLE IF NOT EXISTS wishes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        text TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS counters (
        day TEXT NOT NULL,
        service_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        n INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (day, service_id, kind)
      );
    `);
    this.migrate();
  }

  /** Additive migrations for databases created by older versions (columns are only ever added). */
  private migrate(): void {
    const have = new Set((this.db.prepare(`PRAGMA table_info(requests)`).all() as { name: string }[]).map((c) => c.name));
    const added: [string, string][] = [
      ["payment_nonce", "TEXT"],
      ["payment_asset", "TEXT"],
      ["payment_to", "TEXT"],
      ["payment_amount", "TEXT"],
      ["payment_valid_before", "TEXT"],
      ["settlement_started", "INTEGER NOT NULL DEFAULT 0"],
      ["reconciliation_cursor", "TEXT"],
      ["reconciliation_checked_at", "TEXT"],
      ["input_hash", "TEXT"],
      ["input_json", "TEXT"],
      ["retries", "INTEGER NOT NULL DEFAULT 0"],
      ["result_token_hash", "TEXT"],
    ];
    for (const [name, type] of added) {
      if (!have.has(name)) this.db.exec(`ALTER TABLE requests ADD COLUMN ${name} ${type}`);
    }
  }

  /**
   * Atomically claim a request. Returns false if the same payment was already
   * used (replay or client retry) — the UNIQUE constraint is the guard, so two
   * concurrent requests carrying the same payment can never both proceed.
   */
  claim(row: ClaimRow): boolean {
    try {
      this.db
        .prepare(
          `INSERT INTO requests (id, service_id, created_at, status, data_source, price_usdc, payment_key, network, payer,
                                 input_hash, input_json, result_token_hash)
           VALUES (?, ?, ?, 'processing', ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.id,
          row.service_id,
          new Date().toISOString(),
          row.data_source,
          row.price_usdc,
          row.payment_key,
          row.network,
          row.payer,
          row.input_hash,
          row.input_json,
          row.result_token_hash,
        );
      return true;
    } catch (err) {
      if (String((err as Error).message).includes("UNIQUE")) return false;
      throw err;
    }
  }

  /** Persist only public authorization metadata; never store the signature. */
  recordAuthorization(id: string, auth: { nonce: string; asset: string; to: string; amount: string; validBefore: string }): void {
    this.db.prepare(`UPDATE requests SET payment_nonce=?, payment_asset=?, payment_to=?, payment_amount=?, payment_valid_before=? WHERE id=? AND status='processing'`)
      .run(auth.nonce, auth.asset, auth.to, auth.amount, auth.validBefore, id);
  }

  startSettlement(key: string): boolean {
    return Number(this.db.prepare(`UPDATE requests SET settlement_started=1 WHERE payment_key=? AND status='processing' AND settlement_started=0 AND payment_nonce IS NOT NULL`).run(key).changes) === 1;
  }

  reconciliationCandidates(network: string, limit = 5): RequestRow[] {
    return this.db.prepare(`SELECT * FROM requests WHERE network=? AND status='failed' AND tx_hash IS NULL
      AND error_code IN ('settlement_uncertain', 'interrupted_unsettled') AND payment_nonce IS NOT NULL
      ORDER BY COALESCE(reconciliation_checked_at, '') ASC, created_at ASC LIMIT ?`).all(network, limit) as unknown as RequestRow[];
  }

  touchReconciliation(id: string): void {
    this.db.prepare(`UPDATE requests SET reconciliation_checked_at=? WHERE id=?`).run(new Date().toISOString(), id);
  }

  setReconciliationCursor(id: string, block: bigint): void {
    this.db.prepare(`UPDATE requests SET reconciliation_cursor=? WHERE id=? AND tx_hash IS NULL`).run(block.toString(), id);
  }

  /** Record a confirmed late payment without running an upstream call or resetting retries. */
  reconcileSettled(id: string, txHash: string): boolean {
    return Number(this.db.prepare(`UPDATE requests SET tx_hash=?, error_code='settled_after_timeout' WHERE id=? AND status='failed' AND tx_hash IS NULL
      AND error_code IN ('settlement_uncertain', 'interrupted_unsettled')`).run(txHash, id).changes) === 1;
  }

  /** Record a successful on-chain settlement for a claimed request. */
  setSettled(id: string, txHash: string, payer: string | null): void {
    this.db.prepare(`UPDATE requests SET tx_hash = ?, payer = COALESCE(?, payer) WHERE id = ?`).run(txHash, payer, id);
  }

  complete(id: string, r: { resultJson: string; upstreamCostUsd: number; cacheHit: boolean }): void {
    this.db
      .prepare(`UPDATE requests SET status='completed', result_json=?, upstream_cost_usd=upstream_cost_usd+?, cache_hit=?, error_code=NULL WHERE id=?`)
      .run(r.resultJson, r.upstreamCostUsd, r.cacheHit ? 1 : 0, id);
  }

  fail(id: string, errorCode: string, upstreamCostUsd = 0): void {
    this.db
      .prepare(`UPDATE requests SET status='failed', error_code=?, upstream_cost_usd=upstream_cost_usd+? WHERE id=?`)
      .run(errorCode, upstreamCostUsd, id);
  }

  /**
   * Drop only a claim for which settlement was never attempted.
   * Once settlement started, keep the row even without a transaction hash.
   */
  release(id: string): void {
    this.db.prepare(`DELETE FROM requests WHERE id = ? AND status = 'processing' AND tx_hash IS NULL AND settlement_started=0`).run(id);
  }

  /** Allow exactly one free re-run of a paid request whose upstream call failed. */
  beginRetry(id: string, maxRetries = 1): boolean {
    const r = this.db
      .prepare(`UPDATE requests SET status='processing', retries=retries+1 WHERE id=? AND status='failed' AND tx_hash IS NOT NULL AND retries < ?`)
      .run(id, maxRetries);
    return Number(r.changes) === 1;
  }

  rotateToken(id: string, tokenHash: string): void {
    this.db.prepare(`UPDATE requests SET result_token_hash = ? WHERE id = ?`).run(tokenHash, id);
  }

  get(id: string): RequestRow | undefined {
    return this.db.prepare(`SELECT * FROM requests WHERE id = ?`).get(id) as RequestRow | undefined;
  }

  getByPaymentKey(key: string): RequestRow | undefined {
    return this.db.prepare(`SELECT * FROM requests WHERE payment_key = ?`).get(key) as RequestRow | undefined;
  }

  /** Count an event (request, refusal, 402 challenge, ...) without storing anything about the caller. */
  bump(serviceId: string, kind: string): void {
    this.db
      .prepare(
        `INSERT INTO counters (day, service_id, kind, n) VALUES (?, ?, ?, 1)
         ON CONFLICT(day, service_id, kind) DO UPDATE SET n = n + 1`,
      )
      .run(today(), serviceId, kind);
  }

  /** Real (live, not sandbox) upstream spend in USD since the given ISO date, e.g. '2026-10-20' or '2026-10-01'. */
  upstreamSpendSince(since: string): number {
    const row = this.db
      .prepare(`SELECT COALESCE(SUM(upstream_cost_usd), 0) AS s FROM requests WHERE created_at >= ? AND data_source = 'live'`)
      .get(since) as { s: number };
    return row.s;
  }

  stats(period: "day" | "month") {
    const since = period === "day" ? today() : `${today().slice(0, 7)}-01`;
    const perService = this.db
      .prepare(
        `SELECT service_id,
                COUNT(*) AS requests,
                SUM(CASE WHEN tx_hash IS NOT NULL THEN 1 ELSE 0 END) AS paid,
                SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed,
                SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
                SUM(CASE WHEN tx_hash IS NOT NULL THEN price_usdc ELSE 0 END) AS revenue_usdc,
                SUM(upstream_cost_usd) AS upstream_cost_usd,
                SUM(cache_hit) AS cache_hits
         FROM requests WHERE created_at >= ? GROUP BY service_id ORDER BY service_id`,
      )
      .all(since);
    const counters = this.db
      .prepare(`SELECT service_id, kind, SUM(n) AS n FROM counters WHERE day >= ? GROUP BY service_id, kind`)
      .all(since);
    return { since, perService, counters };
  }

  /**
   * Data minimization: delete what customers sent and what we returned once the retention period is over.
   * Kept for bookkeeping: id, service, time, status, price, network, payer address, tx hash, costs, error code.
   * (The result token HASH stays so an old token gets "expired" instead of "not found".)
   */
  purgeOldPayloads(retentionDays: number, now: Date = new Date()): number {
    const cutoff = new Date(now.getTime() - retentionDays * 86_400_000).toISOString();
    const r = this.db
      .prepare(
        `UPDATE requests SET input_json = NULL, result_json = NULL, input_hash = NULL
         WHERE created_at < ? AND status != 'processing' AND (input_json IS NOT NULL OR result_json IS NOT NULL OR input_hash IS NOT NULL)`,
      )
      .run(cutoff);
    this.db.prepare(`DELETE FROM wishes WHERE created_at < ?`).run(cutoff);
    return Number(r.changes);
  }

  /**
   * Call once at startup (single instance): requests that were still in flight when the process stopped are
   * finished off so nothing stays 'processing' forever.
   *  - settled (tx recorded): marked failed so the payer can use the one free retry
   *  - not recorded as settled: marked failed/interrupted and KEPT (the payment may have settled on-chain without us
   *    noticing); they appear under "needs attention" for a manual check against the chain
   */
  recoverAfterRestart(): { settled: number; unsettled: number } {
    const settled = this.db
      .prepare(`UPDATE requests SET status='failed', error_code='interrupted' WHERE status='processing' AND tx_hash IS NOT NULL`)
      .run();
    const unsettled = this.db
      .prepare(`UPDATE requests SET status='failed', error_code='interrupted_unsettled' WHERE status='processing' AND tx_hash IS NULL AND payment_key IS NOT NULL`)
      .run();
    // Sandbox requests (no payment) have nothing to preserve.
    this.db.prepare(`DELETE FROM requests WHERE status='processing' AND payment_key IS NULL`).run();
    return { settled: Number(settled.changes), unsettled: Number(unsettled.changes) };
  }

  /** Totals, per-service and per-network figures for the admin page. Revenue counts only settled payments. */
  summary(period: "day" | "month") {
    const since = period === "day" ? today() : `${today().slice(0, 7)}-01`;
    const totals = this.db
      .prepare(
        `SELECT COUNT(*) AS requests,
                COALESCE(SUM(CASE WHEN tx_hash IS NOT NULL THEN 1 ELSE 0 END), 0) AS paid,
                COALESCE(SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END), 0) AS completed,
                COALESCE(SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END), 0) AS failed,
                COALESCE(SUM(cache_hit), 0) AS cache_hits
         FROM requests WHERE created_at >= ?`,
      )
      .get(since) as Record<string, number>;
    const perNetwork = this.db
      .prepare(
        `SELECT COALESCE(network, 'none') AS network, data_source,
                COUNT(*) AS requests,
                SUM(CASE WHEN tx_hash IS NOT NULL THEN 1 ELSE 0 END) AS paid,
                COALESCE(SUM(CASE WHEN tx_hash IS NOT NULL THEN price_usdc ELSE 0 END), 0) AS revenue_usdc,
                COALESCE(SUM(upstream_cost_usd), 0) AS upstream_cost_usd
         FROM requests WHERE created_at >= ? GROUP BY network, data_source ORDER BY network, data_source`,
      )
      .all(since) as unknown as NetworkRow[];
    const { perService, counters } = this.stats(period);
    return { since, totals, perNetwork, perService, counters };
  }

  /** Paid requests that ended in failure and have no free retry left: candidates for a manual refund. */
  needsAttention(limit = 20) {
    return this.db
      .prepare(
        `SELECT id, service_id, created_at, status, network, payer, tx_hash, price_usdc, retries, error_code
         FROM requests
         WHERE status != 'completed' AND (tx_hash IS NOT NULL OR error_code LIKE 'interrupted%' OR error_code='settlement_uncertain')
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit) as Record<string, string | number | null>[];
  }

  /** Uptime monitoring: the running server records each minute it was up (no request or caller data). */
  beat(now: Date = new Date()): void {
    this.db.prepare(`INSERT OR IGNORE INTO heartbeats (minute) VALUES (?)`).run(now.toISOString().slice(0, 16));
    this.db.prepare(`DELETE FROM heartbeats WHERE minute < ?`).run(new Date(now.getTime() - 120 * 86_400_000).toISOString().slice(0, 16));
  }

  /** Minutes up between two ISO minute strings (inclusive start, exclusive end), and the first recorded minute ever. */
  heartbeatsBetween(from: string, to: string): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM heartbeats WHERE minute >= ? AND minute < ?`).get(from, to) as { n: number }).n;
  }

  firstHeartbeat(): string | null {
    return (this.db.prepare(`SELECT MIN(minute) AS m FROM heartbeats`).get() as { m: string | null }).m;
  }

  /** Paid real-money calls per service since `since`: delivered vs failed (for the public status page, percentages only). */
  deliveryStats(since: string) {
    return this.db
      .prepare(
        `SELECT service_id,
                SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS delivered,
                SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed
         FROM requests WHERE created_at >= ? AND tx_hash IS NOT NULL AND network = ? GROUP BY service_id`,
      )
      .all(since, MAINNET_NETWORK) as { service_id: string; delivered: number; failed: number }[];
  }

  /** Wishlist: free text from visitors (no caller data). Deleted with the other payloads after the retention period. */
  addWish(text: string, now: Date = new Date()): void {
    this.db.prepare(`INSERT INTO wishes (created_at, text) VALUES (?, ?)`).run(now.toISOString(), text);
  }

  recentWishes(limit = 50) {
    return this.db.prepare(`SELECT created_at, text FROM wishes ORDER BY id DESC LIMIT ?`).all(limit) as { created_at: string; text: string }[];
  }

  /** Real-money (mainnet) figures per day for the last `days` days, oldest first, missing days filled with zeros. */
  history(days = 30, now: Date = new Date()) {
    const first = new Date(now.getTime() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
    const rows = this.db
      .prepare(
        `SELECT substr(created_at, 1, 10) AS day,
                SUM(CASE WHEN tx_hash IS NOT NULL THEN 1 ELSE 0 END) AS paid,
                SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
                COALESCE(SUM(CASE WHEN tx_hash IS NOT NULL THEN price_usdc ELSE 0 END), 0) AS revenue_usdc,
                COALESCE(SUM(upstream_cost_usd), 0) AS cost_usd
         FROM requests WHERE created_at >= ? AND network = ? GROUP BY day`,
      )
      .all(first, MAINNET_NETWORK) as { day: string; paid: number; failed: number; revenue_usdc: number; cost_usd: number }[];
    const byDay = new Map(rows.map((r) => [r.day, r]));
    return Array.from({ length: days }, (_, i) => {
      const day = new Date(now.getTime() - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10);
      return byDay.get(day) ?? { day, paid: 0, failed: 0, revenue_usdc: 0, cost_usd: 0 };
    });
  }

  /** Margin and reliability per service on real money since `since` (ISO date). Only settled payments count as revenue. */
  serviceMargins(since: string) {
    return this.db
      .prepare(
        `SELECT service_id,
                SUM(CASE WHEN tx_hash IS NOT NULL THEN 1 ELSE 0 END) AS paid,
                SUM(CASE WHEN tx_hash IS NOT NULL AND status='completed' THEN 1 ELSE 0 END) AS delivered,
                SUM(CASE WHEN tx_hash IS NOT NULL AND status='failed' THEN 1 ELSE 0 END) AS failed,
                COALESCE(SUM(CASE WHEN tx_hash IS NOT NULL THEN price_usdc ELSE 0 END), 0) AS revenue_usdc,
                COALESCE(SUM(upstream_cost_usd), 0) AS cost_usd
         FROM requests WHERE created_at >= ? AND network = ? GROUP BY service_id ORDER BY revenue_usdc DESC, service_id`,
      )
      .all(since, MAINNET_NETWORK) as { service_id: string; paid: number; delivered: number; failed: number; revenue_usdc: number; cost_usd: number }[];
  }

  /** Buyers by wallet address (public chain data) on real money since `since`: totals plus the top spenders. */
  buyers(since: string, top = 10) {
    const totals = this.db
      .prepare(
        `SELECT COUNT(*) AS buyers, COALESCE(SUM(CASE WHEN calls >= 2 THEN 1 ELSE 0 END), 0) AS repeat_buyers
         FROM (SELECT payer, COUNT(*) AS calls FROM requests WHERE created_at >= ? AND network = ? AND tx_hash IS NOT NULL AND payer IS NOT NULL GROUP BY payer)`,
      )
      .get(since, MAINNET_NETWORK) as { buyers: number; repeat_buyers: number };
    const topBuyers = this.db
      .prepare(
        `SELECT payer, COUNT(*) AS calls, SUM(price_usdc) AS usdc, MAX(created_at) AS last_seen
         FROM requests WHERE created_at >= ? AND network = ? AND tx_hash IS NOT NULL AND payer IS NOT NULL
         GROUP BY payer ORDER BY usdc DESC, calls DESC LIMIT ?`,
      )
      .all(since, MAINNET_NETWORK, top) as { payer: string; calls: number; usdc: number; last_seen: string }[];
    return { ...totals, top: topBuyers };
  }

  /** Admin insights: event counters per UTC day and kind since `since` (YYYY-MM-DD). */
  countersDaily(since: string) {
    return this.db.prepare(`SELECT day, kind, SUM(n) AS n FROM counters WHERE day >= ? GROUP BY day, kind`).all(since) as { day: string; kind: string; n: number }[];
  }

  /** Admin insights: event counters per service and kind in [from, to) (YYYY-MM-DD). */
  countersByService(from: string, to: string) {
    return this.db.prepare(`SELECT service_id, kind, SUM(n) AS n FROM counters WHERE day >= ? AND day < ? GROUP BY service_id, kind`).all(from, to) as { service_id: string; kind: string; n: number }[];
  }

  /** Admin insights: real-money paid calls per day, service and payer since `since` (ISO). */
  paidRows(since: string) {
    return this.db
      .prepare(
        `SELECT substr(created_at, 1, 10) AS day, service_id, payer, price_usdc, upstream_cost_usd, status
         FROM requests WHERE created_at >= ? AND network = ? AND tx_hash IS NOT NULL`,
      )
      .all(since, MAINNET_NETWORK) as { day: string; service_id: string; payer: string | null; price_usdc: number; upstream_cost_usd: number; status: string }[];
  }

  /** First real-money payment per payer (for "new buyers per day"). */
  firstPayments() {
    return this.db
      .prepare(`SELECT payer, MIN(created_at) AS first FROM requests WHERE network = ? AND tx_hash IS NOT NULL AND payer IS NOT NULL GROUP BY payer`)
      .all(MAINNET_NETWORK) as { payer: string; first: string }[];
  }

  /** Requested locations (paid and free calls) since `since`, from stored inputs (kept for the retention period only). */
  locationCounts(since: string) {
    return this.db
      .prepare(
        `SELECT json_extract(input_json, '$.location_code') AS loc, COUNT(*) AS n FROM requests
         WHERE created_at >= ? AND input_json IS NOT NULL AND json_valid(input_json) GROUP BY loc ORDER BY n DESC LIMIT 15`,
      )
      .all(since) as { loc: number | null; n: number }[];
  }

  /** Settled real-money payments of one month ("YYYY-MM") for bookkeeping, oldest first. */
  paymentsOfMonth(month: string) {
    return this.db
      .prepare(
        `SELECT created_at, service_id, price_usdc, network, payer, tx_hash, status
         FROM requests WHERE substr(created_at, 1, 7) = ? AND network = ? AND tx_hash IS NOT NULL ORDER BY created_at LIMIT 100000`,
      )
      .all(month, MAINNET_NETWORK) as { created_at: string; service_id: string; price_usdc: number; network: string; payer: string | null; tx_hash: string; status: string }[];
  }

  close(): void {
    this.db.close();
  }
}

const MAINNET_NETWORK = "eip155:8453";

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}
