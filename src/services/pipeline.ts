import { createHash, randomBytes, randomUUID } from "node:crypto";
import { cacheKey, TtlCache } from "../lib/cache.js";
import type { CostGuard, Refusal } from "../lib/costGuard.js";
import type { RequestRow, Store } from "../lib/store.js";
import { log } from "../lib/log.js";
import { DataForSeoError, type DataForSeoClient, type DfsTask } from "../dataforseo/client.js";
import { serviceConfig } from "../config/services.js";
import type { ServiceDefinition, ServiceResponse } from "./types.js";

export type Prepared<I = unknown> = {
  service: ServiceDefinition<I>;
  input: I;
  inputHash: string;
  estimateUsd: number;
  cached: boolean;
};

export type PrepareOutcome<I = unknown> =
  | { ok: true; prepared: Prepared<I> }
  | { ok: false; httpStatus: number; body: { error: string; message: string; issues?: unknown } };

/**
 * The single execution path for every paid service:
 *
 *   prepare()  free:   validate input, estimate worst-case cost, budget/rate check
 *   [payment]  phase2: 402 challenge -> verify -> claim(payment) -> settle
 *   execute()  paid:   cache hit or exactly ONE DataForSEO call, store result
 *
 * No step retries an upstream call. A claimed request row is the idempotency
 * anchor: it exists before the upstream call, so a payment can trigger at most one.
 */
export class Pipeline {
  private readonly cache = new TtlCache<{ result: unknown; costUsd: number }>(2000);
  private readonly inflight = new Map<string, Promise<{ result: unknown; costUsd: number; cached: boolean }>>();
  private readonly disabled: Set<string>;

  constructor(
    private readonly deps: {
      dfs: DataForSeoClient;
      store: Store;
      guard: CostGuard;
      services: ServiceDefinition[];
      disabledServices?: string[];
    },
  ) {
    this.disabled = new Set(deps.disabledServices ?? []);
  }

  get services(): ServiceDefinition[] {
    return this.deps.services;
  }

  get dataSource(): "sandbox" | "live" {
    return this.deps.dfs.mode;
  }

  isEnabled(service: ServiceDefinition): boolean {
    return service.enabled && !this.disabled.has(service.id);
  }

  prepare<I>(service: ServiceDefinition<I>, body: unknown): PrepareOutcome<I> {
    if (!this.isEnabled(service)) {
      return { ok: false, httpStatus: 503, body: { error: "service_disabled", message: `${service.name} is currently disabled.` } };
    }
    const parsed = service.inputSchema.safeParse(body ?? {});
    if (!parsed.success) {
      return {
        ok: false,
        httpStatus: 400,
        body: {
          error: "invalid_input",
          message: "Request body failed validation. Nothing was charged.",
          issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        },
      };
    }
    const input = parsed.data;
    const invalid = service.validateInput?.(input);
    if (invalid) {
      return { ok: false, httpStatus: 422, body: { error: "unsupported_parameters", message: `${invalid} Nothing was charged.` } };
    }
    const key = cacheKey(service.id, input);
    const cached = this.cache.get(key) !== undefined;
    // A cache hit costs us nothing upstream; still refuse inputs whose worst case is too expensive.
    const estimateUsd = service.estimateCostUsd(input);
    const refusal = cached ? this.ceilingOnly(service, estimateUsd) : this.deps.guard.check(service.id, estimateUsd, service.upstream.maxCostUsd, serviceConfig(service.id).upstreamPerMinute);
    if (refusal) return refusalOutcome(refusal);
    return { ok: true, prepared: { service, input, inputHash: key, estimateUsd: cached ? 0 : estimateUsd, cached } };
  }

  /**
   * Reserve budget + rate slot right before a payment is settled, so we never take money
   * for a call the guard would refuse a moment later. Call release() when done.
   */
  reserve(p: Prepared): { refusal: Refusal } | { release: () => void; refundSlot: () => void } {
    if (p.cached) return { release: () => {}, refundSlot: () => {} };
    const cfg = serviceConfig(p.service.id);
    const r = this.deps.guard.reserve(p.service.id, p.estimateUsd, p.service.upstream.maxCostUsd, cfg.upstreamPerMinute);
    if ("refusal" in r) return r;
    return r;
  }

  /**
   * Claim a store row for a prepared request and hand out its result token.
   * Returns null if the payment key was already used (see Store.claim).
   */
  claim(
    p: Prepared,
    payment: { key: string; network: string; payer: string | null; priceUsdc: number } | null,
  ): { requestId: string; resultToken: string } | null {
    const requestId = newRequestId();
    const resultToken = newToken();
    const ok = this.deps.store.claim({
      id: requestId,
      service_id: p.service.id,
      data_source: this.dataSource,
      price_usdc: payment?.priceUsdc ?? 0,
      payment_key: payment?.key ?? null,
      network: payment?.network ?? null,
      payer: payment?.payer ?? null,
      input_hash: p.inputHash,
      input_json: JSON.stringify(p.input),
      result_token_hash: hashToken(resultToken),
    });
    return ok ? { requestId, resultToken } : null;
  }

  /**
   * Run a prepared request whose row has already been claimed in the store.
   * Marks the row completed or failed; upstream problems are rethrown as DataForSeoError.
   */
  async execute(p: Prepared, requestId: string): Promise<ServiceResponse<unknown>> {
    const { service, input, inputHash } = p;
    try {
      const out = await this.fetchOnce(service, input, inputHash);
      const response: ServiceResponse<unknown> = {
        request_id: requestId,
        service: service.id,
        data_source: this.dataSource,
        cached: out.cached,
        ...(service.notice ? { notice: service.notice } : {}),
        result: out.result,
      };
      this.deps.store.complete(requestId, {
        resultJson: JSON.stringify(response),
        upstreamCostUsd: out.cached ? 0 : out.costUsd,
        cacheHit: out.cached,
      });
      return response;
    } catch (err) {
      const e = err instanceof DataForSeoError ? err : new DataForSeoError("internal error", "internal");
      // A timeout may still be billed by the provider: book the worst-case estimate so the budget and margin stay honest.
      const cost = e.code === "timeout" ? Math.max(e.costUsd, p.estimateUsd) : e.costUsd;
      this.deps.store.fail(requestId, String(e.code), cost);
      log.warn("upstream call failed", { requestId, service: service.id, code: e.code, cost });
      throw e;
    }
  }

  /**
   * Execute an already claimed request and shape the public answer (shared by REST and MCP).
   * Success: 200 + result + result_token. Upstream failure: error body with request_id, result_token and,
   * for paid requests, how to use the one free retry.
   */
  async runClaimed(
    p: Prepared,
    requestId: string,
    resultToken: string,
    opts: { paid: boolean; via: "rest" | "mcp" },
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    if (opts.paid && !this.deps.store.get(requestId)?.tx_hash) {
      this.deps.store.fail(requestId, "settlement_uncertain");
      return { status: 503, body: { error: "payment_pending", message: "Payment outcome is being checked. Do not send a new payment.", request_id: requestId, result_token: resultToken } };
    }
    try {
      const response = await this.execute(p, requestId);
      return { status: 200, body: { ...response, result_token: resultToken } };
    } catch (err) {
      const pub = publicUpstreamError(err instanceof DataForSeoError ? err : new DataForSeoError("internal", "internal"));
      return {
        status: pub.httpStatus,
        body: {
          ...pub.body,
          request_id: requestId,
          result_token: resultToken,
          ...(opts.paid
            ? {
                paid: true,
                retry_available: MAX_FREE_RETRIES > 0,
                retry:
                  opts.via === "mcp"
                    ? `Call the free tool retry_request with this request_id and result_token (once).`
                    : `POST /api/v1/results/${requestId}/retry with Authorization: Bearer <result_token> (free, once)`,
              }
            : {}),
        },
      };
    }
  }

  /**
   * One free, explicitly requested re-run of a PAID request whose upstream call failed.
   * Goes through the same budget/rate checks; never triggered automatically.
   */
  async retry(requestId: string, token: string | undefined): Promise<{ status: number; body: unknown }> {
    const row = this.authorizedRow(requestId, token);
    if (!row) return notFound();
    return this.retryRow(row);
  }

  /** The retry itself, for a row the caller is already entitled to (valid token, or the paying request replayed). */
  async retryRow(row: RequestRow): Promise<{ status: number; body: unknown }> {
    const requestId = row.id;
    const service = findServiceById(this.services, row.service_id);
    if (row.status !== "failed" || !row.tx_hash || row.retries >= MAX_FREE_RETRIES || !service || !row.input_json) {
      return { status: 409, body: { error: "retry_not_available", message: "Only failed paid requests can be retried, once." } };
    }
    const prep = this.prepare(service, JSON.parse(row.input_json ?? "null"));
    if (!prep.ok) return { status: prep.httpStatus, body: { ...prep.body, message: `${prep.body.message.replace(" Nothing was charged.", "")} Retry later.` } };
    const reservation = this.reserve(prep.prepared);
    if ("refusal" in reservation) return { status: reservation.refusal.httpStatus, body: { error: reservation.refusal.code, message: reservation.refusal.message } };
    if (!this.deps.store.beginRetry(requestId, MAX_FREE_RETRIES)) {
      reservation.release();
      reservation.refundSlot();
      return { status: 409, body: { error: "retry_not_available", message: "Retry already in progress or used." } };
    }
    try {
      return { status: 200, body: await this.execute(prep.prepared, requestId) };
    } catch (err) {
      const pub = publicUpstreamError(err as DataForSeoError);
      return { status: pub.httpStatus, body: { ...pub.body, request_id: requestId, retry_available: false } };
    } finally {
      reservation.release();
    }
  }

  /** Cache, then de-duplicate concurrent identical calls, then exactly one upstream POST (packages: their fixed set of POSTs). */
  private async fetchOnce(service: ServiceDefinition, input: unknown, key: string) {
    const hit = this.cache.get(key);
    if (hit) return { result: hit.result, costUsd: 0, cached: true };

    const running = this.inflight.get(key);
    if (running) return { ...(await running), cached: true, costUsd: 0 };

    const promise = (async () => {
      const { task, costUsd, result } = service.extraSteps?.length ? await this.fetchPackage(service, input) : await this.fetchSingle(service, input);
      this.cache.set(key, { result, costUsd }, service.cacheTtlSeconds);
      return { result, costUsd, cached: false };
    })();
    this.inflight.set(key, promise);
    try {
      return await promise;
    } finally {
      this.inflight.delete(key);
    }
  }

  private async fetchSingle(service: ServiceDefinition, input: unknown) {
    const { task, costUsd } = await this.deps.dfs.post(service.upstream.endpoint, service.buildRequest(input));
    return { task, costUsd, result: service.mapResult(task, input) };
  }

  /** Package: all steps in parallel. Every charged cost is booked, also when one step fails (then the whole call fails). */
  private async fetchPackage(service: ServiceDefinition, input: unknown) {
    const steps = [{ endpoint: service.upstream.endpoint, buildRequest: service.buildRequest }, ...service.extraSteps!];
    const settled = await Promise.allSettled(steps.map((s) => this.deps.dfs.post(s.endpoint, s.buildRequest(input))));
    let costUsd = 0;
    let failure: DataForSeoError | undefined;
    for (const r of settled) {
      if (r.status === "fulfilled") costUsd += r.value.costUsd;
      else {
        const e = r.reason instanceof DataForSeoError ? r.reason : new DataForSeoError("internal error", "internal");
        costUsd += e.costUsd;
        failure ??= e;
      }
    }
    if (failure) throw new DataForSeoError(failure.message, failure.code, costUsd);
    const tasks = settled.map((r) => (r as PromiseFulfilledResult<{ task: DfsTask }>).value.task);
    return { task: tasks[0]!, costUsd, result: service.mapPackage!(tasks, input) };
  }

  private ceilingOnly(service: ServiceDefinition, estimateUsd: number): Refusal | null {
    return estimateUsd > service.upstream.maxCostUsd
      ? { code: "cost_ceiling", httpStatus: 422, message: `Request exceeds the cost ceiling for ${service.id}.` }
      : null;
  }

  /** Result lookup: requires the bearer token handed out with the original response. */
  lookup(requestId: string, token: string | undefined): { status: number; body: unknown } {
    const row = this.authorizedRow(requestId, token);
    if (!row) return notFound();
    if (row.status === "completed") {
      if (!row.result_json) return { status: 410, body: { error: "expired", message: "This result was deleted after the retention period (see the privacy notice). Request it again to get fresh data." } };
      return { status: 200, body: JSON.parse(row.result_json) };
    }
    return { status: 200, body: requestState(row) };
  }

  private authorizedRow(requestId: string, token: string | undefined): RequestRow | undefined {
    const row = this.deps.store.get(requestId);
    if (!row || !token || !row.result_token_hash || !safeEqual(row.result_token_hash, hashToken(token))) return undefined;
    return row;
  }
}

export const MAX_FREE_RETRIES = 1;

/** Public view of a request that has no (or not yet a) result. */
export function requestState(row: RequestRow) {
  return {
    request_id: row.id,
    service: row.service_id,
    status: row.status,
    paid: row.tx_hash !== null,
    ...(row.tx_hash ? { transaction: row.tx_hash, network: row.network } : {}),
    ...(row.error_code ? { error: "upstream_error" } : {}),
    retry_available: row.status === "failed" && row.tx_hash !== null && row.retries < MAX_FREE_RETRIES,
  };
}

function notFound() {
  // Same answer for "unknown id" and "wrong token": do not leak which ids exist.
  return { status: 404, body: { error: "not_found", message: "Unknown request id or invalid result token." } };
}

function findServiceById(services: ServiceDefinition[], id: string) {
  return services.find((s) => s.id === id);
}

export function newToken(): string {
  return randomBytes(24).toString("base64url");
}

export function newRequestId(): string {
  return randomUUID();
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function refusalOutcome(r: Refusal): PrepareOutcome<never> {
  return { ok: false, httpStatus: r.httpStatus, body: { error: r.code, message: `${r.message} Nothing was charged.` } };
}

/** Map an upstream failure to a public error without leaking internals. */
export function publicUpstreamError(e: DataForSeoError): { httpStatus: number; body: { error: string; message: string } } {
  const code = e.code;
  if (code === 40501 || code === 40503 || code === 40506) {
    return { httpStatus: 422, body: { error: "unsupported_parameters", message: "The data provider rejected these parameters." } };
  }
  if (code === 40102) return { httpStatus: 404, body: { error: "no_results", message: "The data provider returned no results." } };
  if (code === "timeout") return { httpStatus: 504, body: { error: "upstream_timeout", message: "The data provider timed out." } };
  return { httpStatus: 502, body: { error: "upstream_error", message: "The data provider is temporarily unavailable." } };
}
