import type { Store } from "../lib/store.js";
import type { Pipeline } from "../services/pipeline.js";

/**
 * Public status: uptime from the server's own minute heartbeats (a minute without heartbeat counts as down,
 * including deploy restarts) and delivery success of paid calls per service. Aggregates only, no caller data.
 */
const MIN = 60_000;
const minute = (d: Date) => d.toISOString().slice(0, 16);

export function buildStatus(store: Store, pipeline: Pipeline, now: Date = new Date()) {
  const first = store.firstHeartbeat();
  const firstMs = first ? Date.parse(first + ":00Z") : now.getTime();
  const pct = (fromMs: number) => {
    const start = Math.max(fromMs, firstMs);
    const expected = Math.max(1, Math.floor((now.getTime() - start) / MIN) + 1);
    const up = store.heartbeatsBetween(minute(new Date(start)), minute(new Date(now.getTime() + MIN)));
    return Math.min(100, Math.round((up / expected) * 10000) / 100);
  };
  const days = Array.from({ length: 30 }, (_, i) => {
    const dayStart = Date.parse(new Date(now.getTime() - (29 - i) * 86_400_000).toISOString().slice(0, 10) + "T00:00:00Z");
    const dayEnd = Math.min(dayStart + 86_400_000, now.getTime() + MIN);
    if (dayEnd <= firstMs) return { day: new Date(dayStart).toISOString().slice(0, 10), uptime_pct: null as number | null };
    const start = Math.max(dayStart, firstMs);
    const expected = Math.max(1, Math.floor((dayEnd - start) / MIN));
    const up = store.heartbeatsBetween(minute(new Date(start)), minute(new Date(dayEnd)));
    return { day: new Date(dayStart).toISOString().slice(0, 10), uptime_pct: Math.min(100, Math.round((up / expected) * 10000) / 100) };
  });
  const since = new Date(now.getTime() - 30 * 86_400_000).toISOString();
  const delivery = new Map(store.deliveryStats(since).map((r) => [r.service_id, r]));
  return {
    generated_at: now.toISOString(),
    status: "operational",
    monitoring_since: first ? first + ":00Z" : null,
    uptime_pct: { last_24h: pct(now.getTime() - 86_400_000), last_7d: pct(now.getTime() - 7 * 86_400_000), last_30d: pct(now.getTime() - 30 * 86_400_000) },
    days,
    services: pipeline.services.map((s) => {
      const d = delivery.get(s.id);
      const total = (d?.delivered ?? 0) + (d?.failed ?? 0);
      return { id: s.id, name: s.name, enabled: pipeline.isEnabled(s), paid_delivery_success_pct_30d: total ? Math.round(((d!.delivered ?? 0) / total) * 1000) / 10 : null };
    }),
    method: "Uptime is measured by the server itself: it records every minute it is running. Minutes without a record (outages, restarts during updates) count as down. Delivery success counts paid calls in the last 30 days that returned data.",
  };
}

export type Status = ReturnType<typeof buildStatus>;
