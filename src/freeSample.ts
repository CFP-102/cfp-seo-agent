import { z } from "zod";
import { clientKey } from "./lib/rateLimit.js";
import type { Store } from "./lib/store.js";
import { keywordString } from "./services/common.js";
import type { Pipeline } from "./services/pipeline.js";
import type { ServiceDefinition } from "./services/types.js";

/**
 * Free samples, no payment, so a new agent can try the data:
 *  - POST /api/v1/free-sample: ONE keyword of the keyword-metrics service (legacy route)
 *  - POST /api/v1/free-sample/{service-id}: one call of any single-call service priced up to FREE_SAMPLE_MAX_PRICE_USDC
 * Abuse limits (all in memory, never persisted):
 *  - 1 sample per client and service per UTC day (IPv6 clients are keyed by /64, so rotating addresses inside a prefix does not help)
 *  - one global daily cap on real (non-cached) upstream calls, shared by all samples
 *  - samples only ever use the normal cost guard (daily/monthly DataForSEO budget, upstream rate), and are booked in the ledger
 *  - concurrent requests from one client cannot slip through twice (in-flight marker)
 *  - failed upstream calls do not use up the client's sample
 */
export const FREE_SAMPLE_SERVICE_ID = "keyword-metrics";

export const FreeSampleInput = z.strictObject({
  keyword: keywordString.refine((k) => k.length <= 60, "keyword must be at most 60 characters"),
  location_code: z.number().int().min(1000).max(99_999_999).optional(),
  language_code: z.string().trim().regex(/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/).optional(),
});

export interface FreeSampleDeps {
  pipeline: Pipeline;
  store: Store;
  /** 0 = feature off. Real upstream calls per UTC day, in total. */
  dailyLimit: number;
  now?: () => Date;
}

/** Per-service samples: any single-call service priced at or below this amount (packages never). */
export const FREE_SAMPLE_MAX_PRICE_USDC = 0.05;

export function createFreeSample(deps: FreeSampleDeps) {
  const { pipeline, store, dailyLimit } = deps;
  const clock = deps.now ?? (() => new Date());
  let day = "";
  let used = new Set<string>();
  let inflight = new Set<string>();
  let upstreamToday = 0;

  const roll = () => {
    const d = clock().toISOString().slice(0, 10);
    if (d !== day) {
      day = d;
      used = new Set();
      upstreamToday = 0;
    }
  };
  const service = () => pipeline.services.find((s) => s.id === FREE_SAMPLE_SERVICE_ID);
  const on = () => dailyLimit > 0;
  const eligible = (s: ServiceDefinition) => pipeline.isEnabled(s) && !s.extraSteps?.length && Number(s.priceUsdc) <= FREE_SAMPLE_MAX_PRICE_USDC;
  const eligibleIds = () => pipeline.services.filter(eligible).map((s) => s.id);

  /** Shared core: limits, budget, one upstream call, ledger. `key` identifies "this client, this sample kind". */
  async function sample(svc: ServiceDefinition, ip: string | undefined, rawInput: unknown, kind: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const prep = pipeline.prepare(svc, rawInput);
    if (!prep.ok) return { status: prep.httpStatus, body: prep.body };
    roll();
    const key = `${clientKey(ip)}|${kind}`;
    if (used.has(key)) {
      store.bump(svc.id, "free_sample_refused_client");
      return { status: 429, body: { error: "sample_used", message: "The free sample for this service is limited to one per day per client. Paid calls are not limited this way." } };
    }
    if (inflight.has(key)) return { status: 429, body: { error: "sample_in_progress", message: "A sample for this client is already running." } };
    const cached = prep.prepared.cached;
    if (!cached && upstreamToday >= dailyLimit) {
      store.bump(svc.id, "free_sample_refused_exhausted");
      return { status: 429, body: { error: "sample_exhausted", message: "Today's free samples are used up (UTC). Try again tomorrow or use a paid call." } };
    }

    inflight.add(key);
    if (!cached) upstreamToday++; // reserve the global slot before the call, give it back if nothing was fetched
    const reservation = pipeline.reserve(prep.prepared);
    if ("refusal" in reservation) {
      inflight.delete(key);
      if (!cached) upstreamToday--;
      return { status: reservation.refusal.httpStatus, body: { error: reservation.refusal.code, message: reservation.refusal.message } };
    }
    try {
      const claim = pipeline.claim(prep.prepared, null)!;
      const out = await pipeline.runClaimed(prep.prepared, claim.requestId, claim.resultToken, { paid: false, via: "rest" });
      if (out.status === 200) {
        used.add(key);
        store.bump(svc.id, "free_sample");
        const { result_token: _t, ...rest } = out.body;
        return { status: 200, body: { ...rest, sample: true, sample_notice: "Free sample: one per service per day per client. Buy more with a paid call." } };
      }
      if (!cached) upstreamToday--; // nothing delivered: do not burn the cap
      return { status: out.status, body: out.body };
    } finally {
      reservation.release();
      inflight.delete(key);
    }
  }

  return {
    enabled: () => on() && Boolean(service()) && pipeline.isEnabled(service()!),
    /** For the public catalog. */
    info: () => (
      roll(),
      {
        path: "/api/v1/free-sample",
        per_client_per_day: 1,
        service: FREE_SAMPLE_SERVICE_ID,
        per_service_path: "/api/v1/free-sample/{service-id}",
        per_service_max_price_usdc: String(FREE_SAMPLE_MAX_PRICE_USDC),
        per_service_eligible: eligibleIds(),
        available_today: upstreamToday < dailyLimit,
      }
    ),
    isEligible: (id: string) => {
      const s = pipeline.services.find((x) => x.id === id);
      return !!s && on() && eligible(s);
    },

    /** Legacy sample: ONE keyword of keyword-metrics. */
    async run(ip: string | undefined, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
      const svc = service();
      if (!svc || !on() || !pipeline.isEnabled(svc)) return { status: 404, body: { error: "not_found" } };
      const parsed = FreeSampleInput.safeParse(body ?? {});
      if (!parsed.success) {
        return { status: 400, body: { error: "invalid_input", message: "Send exactly one keyword.", issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) } };
      }
      return sample(svc, ip, { keywords: [parsed.data.keyword], location_code: parsed.data.location_code, language_code: parsed.data.language_code }, FREE_SAMPLE_SERVICE_ID);
    },

    /** One free call per service per client per day, with the service's normal input; only cheap single-call services. */
    async runService(ip: string | undefined, serviceId: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
      const svc = pipeline.services.find((s) => s.id === serviceId);
      if (!svc || !on()) return { status: 404, body: { error: "not_found" } };
      if (!eligible(svc)) {
        return { status: 403, body: { error: "no_free_sample", message: `No free sample for ${svc.id}: samples cover single-call services up to ${FREE_SAMPLE_MAX_PRICE_USDC} USDC. Use a paid call.` } };
      }
      return sample(svc, ip, body ?? {}, `svc:${svc.id}`);
    },
  };
}

export type FreeSample = ReturnType<typeof createFreeSample>;
