import type { Env } from "./config/env.js";
import { dachLocationName } from "./config/locales.js";
import type { Store } from "./lib/store.js";
import type { Pipeline } from "./services/pipeline.js";

/**
 * Admin insights: daily trends and 7-day comparisons from data the server already keeps (event counters,
 * the payment ledger, stored inputs within the retention period). No IPs, no extra tracking.
 */
const DAY = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const COUNTRY: Record<number, string> = { 2276: "Germany", 2040: "Austria", 2756: "Switzerland", 2840: "United States", 2826: "United Kingdom", 2250: "France", 2380: "Italy", 2724: "Spain", 2528: "Netherlands", 2124: "Canada", 2036: "Australia", 2356: "India" };

export function buildInsights(env: Env, store: Store, pipeline: Pipeline, now: Date = new Date()) {
  const days = 30;
  const first = iso(new Date(now.getTime() - (days - 1) * DAY));
  const dayList = Array.from({ length: days }, (_, i) => iso(new Date(now.getTime() - (days - 1 - i) * DAY)));
  const exclude = new Set(env.ADMIN_EXCLUDE_PAYERS.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
  const real = (payer: string | null) => !payer || !exclude.has(payer.toLowerCase());

  // Daily series
  const counters = store.countersDaily(first);
  const c = (day: string, kind: string | ((k: string) => boolean)) =>
    counters.filter((r) => r.day === day && (typeof kind === "string" ? r.kind === kind : kind(r.kind))).reduce((a, r) => a + Number(r.n), 0);
  const paid = store.paidRows(new Date(now.getTime() - days * DAY).toISOString()).filter((r) => real(r.payer));
  const firsts = store.firstPayments().filter((r) => real(r.payer));
  const series = dayList.map((day) => {
    const p = paid.filter((r) => r.day === day);
    return {
      day,
      quotes: c(day, "payment_required"),
      probes: c(day, "probe"),
      free_samples: c(day, "free_sample"),
      preflights: c(day, "preflight"),
      wishes: c(day, "wish"),
      mcp_calls: c(day, (k) => k.endsWith("_call_mcp")),
      paid_calls: p.length,
      revenue_usdc: Math.round(p.reduce((a, r) => a + Number(r.price_usdc), 0) * 1e6) / 1e6,
      cost_usd: Math.round(p.reduce((a, r) => a + Number(r.upstream_cost_usd), 0) * 1e6) / 1e6,
      buyers: new Set(p.map((r) => r.payer)).size,
      new_buyers: firsts.filter((f) => f.first.slice(0, 10) === day).length,
    };
  });

  // 7 days vs the 7 days before
  const sum = (from: number, to: number, k: keyof (typeof series)[number]) => series.slice(from, to).reduce((a, r) => a + Number(r[k]), 0);
  const kpis = (["paid_calls", "revenue_usdc", "buyers", "new_buyers", "free_samples", "quotes", "mcp_calls", "wishes"] as const).map((k) => {
    const cur = sum(days - 7, days, k);
    const prev = sum(days - 14, days - 7, k);
    return { key: k, last_7d: Math.round(cur * 1e6) / 1e6, prev_7d: Math.round(prev * 1e6) / 1e6, change_pct: prev ? Math.round(((cur - prev) / prev) * 1000) / 10 : null };
  });

  // Per service, last 7 days
  const from7 = iso(new Date(now.getTime() - 6 * DAY));
  const byService = store.countersByService(from7, iso(new Date(now.getTime() + DAY)));
  const sc = (id: string, kind: string) => byService.filter((r) => r.service_id === id && r.kind === kind).reduce((a, r) => a + Number(r.n), 0);
  const paid7 = paid.filter((r) => r.day >= from7);
  const services = pipeline.services
    .map((s) => {
      const quotes = sc(s.id, "payment_required");
      const calls = paid7.filter((r) => r.service_id === s.id).length;
      return {
        id: s.id,
        price_usdc: s.priceUsdc,
        quotes_7d: quotes,
        free_samples_7d: sc(s.id, "free_sample"),
        paid_7d: calls,
        revenue_7d: Math.round(paid7.filter((r) => r.service_id === s.id).reduce((a, r) => a + Number(r.price_usdc), 0) * 1e6) / 1e6,
        quote_to_paid_pct: quotes ? Math.round((calls / quotes) * 1000) / 10 : null,
      };
    })
    .sort((a, b) => b.paid_7d - a.paid_7d || b.free_samples_7d - a.free_samples_7d || b.quotes_7d - a.quotes_7d);

  const locations = store.locationCounts(new Date(now.getTime() - days * DAY).toISOString()).map((l) => {
    if (l.loc === null || l.loc === undefined) return { location_code: null, name: "no location (page/domain tools)", calls: Number(l.n) };
    const code = Number(l.loc);
    return { location_code: Number.isFinite(code) ? code : null, name: COUNTRY[code] ?? dachLocationName(code) ?? (Number.isFinite(code) ? `code ${code}` : "none"), calls: Number(l.n) };
  });

  return { generated_at: now.toISOString(), excluded_wallets: exclude.size, series, kpis, services, locations };
}

export type Insights = ReturnType<typeof buildInsights>;
