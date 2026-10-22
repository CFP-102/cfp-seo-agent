import type { Store } from "./store.js";
import { today } from "./store.js";

export type Refusal = { code: string; message: string; httpStatus: number };

/**
 * Decides, BEFORE a payment is accepted, whether we can afford to serve a request:
 * - per-request ceiling (worst-case estimate <= service maxCostUsd)
 * - daily and monthly DataForSEO budget, counting in-flight reservations so
 *   concurrent requests cannot overshoot the limit together
 * - per-endpoint upstream rate (e.g. Google Ads Live: 12/min per account)
 * Reservations are released or committed by the pipeline once the call is done.
 */
export class CostGuard {
  private reservedUsd = 0;
  private rate = new Map<string, { stamp: number; pending: boolean }[]>();

  constructor(
    private readonly store: Store,
    private readonly limits: { dailyUsd: number; monthlyUsd: number; countSpend: boolean },
    private readonly now: () => number = Date.now,
  ) {}

  check(serviceId: string, estimateUsd: number, maxCostUsd: number, perMinute: number): Refusal | null {
    if (estimateUsd > maxCostUsd) {
      return {
        code: "cost_ceiling",
        httpStatus: 422,
        message: `This request would cost up to $${estimateUsd.toFixed(4)} upstream, above the $${maxCostUsd} ceiling for ${serviceId}.`,
      };
    }
    if (this.limits.countSpend) {
      const day = this.store.upstreamSpendSince(today()) + this.reservedUsd;
      if (day + estimateUsd > this.limits.dailyUsd) {
        return { code: "daily_budget", httpStatus: 503, message: "Daily data budget reached. Please try again tomorrow (UTC)." };
      }
      const month = this.store.upstreamSpendSince(today().slice(0, 7) + "-01") + this.reservedUsd;
      if (month + estimateUsd > this.limits.monthlyUsd) {
        return { code: "monthly_budget", httpStatus: 503, message: "Monthly data budget reached." };
      }
    }
    if (this.recentCalls(serviceId).length >= perMinute) {
      return { code: "upstream_busy", httpStatus: 503, message: "Upstream capacity for this service is exhausted for the current minute. Retry in ~60s." };
    }
    return null;
  }

  /** Atomically re-check and reserve budget + one rate slot. Returns a release function. */
  reserve(serviceId: string, estimateUsd: number, maxCostUsd: number, perMinute: number): { refusal: Refusal } | { release: () => void; refundSlot: () => void } {
    const refusal = this.check(serviceId, estimateUsd, maxCostUsd, perMinute);
    if (refusal) return { refusal };
    this.reservedUsd += estimateUsd;
    const calls = this.recentCalls(serviceId);
    const slot = { stamp: this.now(), pending: true };
    calls.push(slot);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        slot.pending = false;
        slot.stamp = this.now();
        this.reservedUsd = Math.max(0, this.reservedUsd - estimateUsd);
      },
      refundSlot: () => {
        this.rate.set(serviceId, this.recentCalls(serviceId).filter((entry) => entry !== slot));
      },
    };
  }

  private recentCalls(serviceId: string): { stamp: number; pending: boolean }[] {
    const cutoff = this.now() - 60_000;
    const list = (this.rate.get(serviceId) ?? []).filter((entry) => entry.pending || entry.stamp > cutoff);
    this.rate.set(serviceId, list);
    return list;
  }
}
