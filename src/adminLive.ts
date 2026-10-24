import type { Env } from "./config/env.js";
import { PAGE_GROUPS, SITE_COUNTER } from "./lib/pageViews.js";
import type { Store } from "./lib/store.js";
import type { Pipeline } from "./services/pipeline.js";

/**
 * Data for the live panel at the top of the admin page (polled every few seconds). Everything comes from the ledger
 * and the anonymous counters the server already keeps; own test wallets and testnet rows are hidden like elsewhere.
 * Days are UTC days, like every other figure of the admin area. Totals are aggregated in SQL, and one snapshot is
 * reused for a few seconds so several open tabs do not multiply the database work.
 */
const DAY = 86_400_000;
const CACHE_MS = 3000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

export interface DayTiles {
  revenue_usdc: number; paid_calls: number; buyers: number; new_buyers: number; requests: number;
  /** Revenue minus ALL live DataForSEO cost of the day (paid calls, free samples, retries, own tests). */
  margin_usd: number; upstream_cost_usd: number;
  quotes: number; free_samples: number; mcp_calls: number; site_views_human: number; site_views_bot: number; failed: number;
}

export function buildLive(env: Env, store: Store, pipeline: Pipeline, now: Date = new Date()) {
  const day = iso(now);
  const yesterday = iso(new Date(now.getTime() - DAY));
  const monthStart = `${day.slice(0, 7)}-01`;

  const counters = store.countersDaily(yesterday);
  const count = (d: string, test: (k: string) => boolean) => counters.filter((r) => r.day === d && test(r.kind)).reduce((a, r) => a + Number(r.n), 0);
  const hourly = store.hourly(day);
  const hourlyYesterday = store.hourly(yesterday);

  const tiles = (d: string): DayTiles => {
    const t = store.dayTotals(d);
    const cost = store.upstreamSpendOn(d);
    const hours = d === day ? hourly : hourlyYesterday;
    return {
      revenue_usdc: round6(t.revenue_usdc),
      paid_calls: t.paid_calls,
      buyers: t.buyers,
      new_buyers: t.new_buyers,
      requests: hours.reduce((a, h) => a + h.requests, 0),
      upstream_cost_usd: round6(cost),
      margin_usd: round6(t.revenue_usdc - cost),
      quotes: count(d, (k) => k === "payment_required"),
      free_samples: count(d, (k) => k === "free_sample"),
      mcp_calls: count(d, (k) => k.endsWith("_call_mcp")),
      site_views_human: count(d, (k) => k.startsWith("view_") && k.endsWith("_human")),
      site_views_bot: count(d, (k) => k.startsWith("view_") && k.endsWith("_bot")),
      failed: t.failed,
    };
  };

  const todayByService = store.countersByService(day, iso(new Date(now.getTime() + DAY)));
  const sum = (id: string, kind: string) => todayByService.filter((r) => r.service_id === id && r.kind === kind).reduce((a, r) => a + Number(r.n), 0);
  const paidToday = new Map(store.serviceMargins(`${day}T00:00`).map((r) => [r.service_id, r]));
  const month = store.paidTotalsSince(`${monthStart}T00:00`);
  const minutesToday = now.getUTCHours() * 60 + now.getUTCMinutes() + 1;
  return {
    generated_at: now.toISOString(),
    day,
    timezone: "UTC",
    mode: { data_source: pipeline.dataSource, payments: env.PAYMENT_MODE },
    today: tiles(day),
    yesterday: tiles(yesterday),
    month: { revenue_usdc: round6(month.revenue_usdc), paid_calls: month.paid_calls },
    needs_attention: store.needsAttention().length,
    uptime_today_pct: Math.min(100, Math.round((store.minutesUp(day) / minutesToday) * 1000) / 10),
    budget: { daily_limit_usd: env.DATAFORSEO_DAILY_LIMIT_USD, daily_spent_usd: store.upstreamSpendSince(day), monthly_limit_usd: env.DATAFORSEO_MONTHLY_LIMIT_USD, monthly_spent_usd: store.upstreamSpendSince(monthStart) },
    hourly: hourly.map((h) => ({ hour: h.hour, requests: h.requests, paid: h.paid, revenue_usdc: round6(h.revenue_usdc) })),
    hourly_yesterday_revenue: hourlyYesterday.map((h) => round6(h.revenue_usdc)),
    by_service: pipeline.services
      .map((s) => ({ id: s.id, paid: paidToday.get(s.id)?.paid ?? 0, revenue_usdc: round6(paidToday.get(s.id)?.revenue_usdc ?? 0), quotes: sum(s.id, "payment_required"), free_samples: sum(s.id, "free_sample") }))
      .filter((s) => s.paid || s.quotes || s.free_samples)
      .sort((a, b) => b.revenue_usdc - a.revenue_usdc || b.paid - a.paid || b.quotes - a.quotes),
    pages: PAGE_GROUPS.map((page) => ({ page, human: sum(SITE_COUNTER, `view_${page}_human`), bot: sum(SITE_COUNTER, `view_${page}_bot`) })),
    recent: store.recentRequests(14).map((r) => ({
      id: r.id, time: r.created_at, service: r.service_id, status: r.status, price_usdc: r.price_usdc, paid: Boolean(r.paid),
      real: r.network === "eip155:8453", payer: r.payer ? `${r.payer.slice(0, 6)}…${r.payer.slice(-4)}` : null, source: r.data_source, cached: Boolean(r.cache_hit), error: r.error_code,
    })),
  };
}
export type Live = ReturnType<typeof buildLive>;

/** One shared snapshot for a few seconds: polling tabs and the page itself reuse it instead of re-querying. */
export function liveSnapshots(env: Env, store: Store, pipeline: Pipeline, ttlMs = CACHE_MS) {
  let cached: { at: number; data: Live } | null = null;
  return (now: Date = new Date()): Live => {
    if (!cached || now.getTime() - cached.at >= ttlMs || now.getTime() < cached.at) cached = { at: now.getTime(), data: buildLive(env, store, pipeline, now) };
    return cached.data;
  };
}
