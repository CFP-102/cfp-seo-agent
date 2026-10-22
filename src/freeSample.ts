import { z } from "zod";
import { clientKey } from "./lib/rateLimit.js";
import type { Store } from "./lib/store.js";
import { today } from "./lib/store.js";
import { keywordString } from "./services/common.js";
import type { Pipeline } from "./services/pipeline.js";

/**
 * Free sample: ONE keyword of the keyword-metrics service, no payment, so a new agent can try the data.
 * Abuse limits (all in memory, never persisted):
 *  - 1 sample per client per UTC day (IPv6 clients are keyed by /64, so rotating addresses inside a prefix does not help)
 *  - a global daily cap on real (non-cached) upstream calls
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

export function createFreeSample(deps: FreeSampleDeps) {
  const { pipeline, store, dailyLimit } = deps;
  const clock = deps.now ?? (() => new Date());
  let day = "";
  let usedClients = new Set<string>();
  let inflight = new Set<string>();
  let upstreamToday = 0;

  const roll = () => {
    const d = clock().toISOString().slice(0, 10);
    if (d !== day) {
      day = d;
      usedClients = new Set();
      upstreamToday = 0;
    }
  };
  const service = () => pipeline.services.find((s) => s.id === FREE_SAMPLE_SERVICE_ID);

  return {
    enabled: () => dailyLimit > 0 && Boolean(service()) && pipeline.isEnabled(service()!),
    /** For the public catalog. */
    info: () => (roll(), { path: "/api/v1/free-sample", per_client_per_day: 1, service: FREE_SAMPLE_SERVICE_ID, available_today: upstreamToday < dailyLimit }),

    async run(ip: string | undefined, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
      const svc = service();
      if (!svc || dailyLimit <= 0 || !pipeline.isEnabled(svc)) return { status: 404, body: { error: "not_found" } };
      const parsed = FreeSampleInput.safeParse(body ?? {});
      if (!parsed.success) {
        return { status: 400, body: { error: "invalid_input", message: "Send exactly one keyword.", issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) } };
      }
      const prep = pipeline.prepare(svc, { keywords: [parsed.data.keyword], location_code: parsed.data.location_code, language_code: parsed.data.language_code });
      if (!prep.ok) return { status: prep.httpStatus, body: prep.body };

      roll();
      const client = clientKey(ip);
      if (usedClients.has(client)) {
        store.bump(svc.id, "free_sample_refused_client");
        return { status: 429, body: { error: "sample_used", message: "The free sample is limited to one per day per client. Paid calls are not limited this way." } };
      }
      if (inflight.has(client)) return { status: 429, body: { error: "sample_in_progress", message: "A sample for this client is already running." } };
      const cached = prep.prepared.cached;
      if (!cached && upstreamToday >= dailyLimit) {
        store.bump(svc.id, "free_sample_refused_exhausted");
        return { status: 429, body: { error: "sample_exhausted", message: "Today's free samples are used up (UTC). Try again tomorrow or use a paid call." } };
      }

      inflight.add(client);
      if (!cached) upstreamToday++; // reserve the global slot before the call, give it back if nothing was fetched
      const reservation = pipeline.reserve(prep.prepared);
      if ("refusal" in reservation) {
        inflight.delete(client);
        if (!cached) upstreamToday--;
        return { status: reservation.refusal.httpStatus, body: { error: reservation.refusal.code, message: reservation.refusal.message } };
      }
      try {
        const claim = pipeline.claim(prep.prepared, null)!;
        const out = await pipeline.runClaimed(prep.prepared, claim.requestId, claim.resultToken, { paid: false, via: "rest" });
        if (out.status === 200) {
          usedClients.add(client);
          store.bump(svc.id, "free_sample");
          const { result_token: _t, ...rest } = out.body;
          return { status: 200, body: { ...rest, sample: true, sample_notice: "Free sample: one keyword per day per client. Buy more with a paid call." } };
        }
        if (!cached) upstreamToday--; // nothing delivered: do not burn the cap
        return { status: out.status, body: out.body };
      } finally {
        reservation.release();
        inflight.delete(client);
      }
    },
  };
}

export type FreeSample = ReturnType<typeof createFreeSample>;
void today;
