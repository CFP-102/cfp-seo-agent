import type { Env } from "./config/env.js";
import { PAGE_GROUPS, SITE_COUNTER } from "./lib/pageViews.js";
import { today, type Store } from "./lib/store.js";
import type { Pipeline } from "./services/pipeline.js";

/**
 * Data for the live panel at the top of the admin page (polled every few seconds). Everything comes from the ledger
 * and the anonymous counters the server already keeps; own test wallets and testnet rows are hidden like elsewhere.
 */
const DAY = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

export interface DayTiles {
  revenue_usdc: number; paid_calls: number; buyers: number; new_buyers: number; requests: number; margin_usd: number;
  quotes: number; free_samples: number; mcp_calls: number; preflights: number; probes: number; wishes: number;
  site_views_human: number; site_views_bot: number; failed: number;
}

export function buildLive(env: Env, store: Store, pipeline: Pipeline, now: Date = new Date()) {
  const day = iso(now);
  const yesterday = iso(new Date(now.getTime() - DAY));
  const monthStart = `${day.slice(0, 7)}-01`;

  const counters = store.countersDaily(yesterday);
  const count = (d: string, test: (k: string) => boolean) => counters.filter((r) => r.day === d && test(r.kind)).reduce((a, r) => a + Number(r.n), 0);
  const paidRows = store.paidRows(`${yesterday}T00:00:00.000Z`);
  const firsts = store.firstPayments();
  const hourly = store.hourly(day);
  const hourlyYesterday = store.hourly(yesterday);

  const tiles = (d: string): DayTiles => {
    const rows = paidRows.filter((r) => r.day === d);
    const revenue = rows.reduce((a, r) => a + Number(r.price_usdc), 0);
    const cost = rows.reduce((a, r) => a + Number(r.upstream_cost_usd), 0);
    const hours = d === day ? hourly : hourlyYesterday;
    return {
      revenue_usdc: round6(revenue),
      paid_calls: rows.length,
      buyers: new Set(rows.map((r) => r.payer)).size,
      new_buyers: firsts.filter((f) => f.first.slice(0, 10) === d).length,
      requests: hours.reduce((a, h) => a + h.requests, 0),
      margin_usd: round6(revenue - cost),
      quotes: count(d, (k) => k === "payment_required"),
      free_samples: count(d, (k) => k === "free_sample"),
      mcp_calls: count(d, (k) => k.endsWith("_call_mcp")),
      preflights: count(d, (k) => k === "preflight"),
      probes: count(d, (k) => k === "probe"),
      wishes: count(d, (k) => k === "wish"),
      site_views_human: count(d, (k) => k.startsWith("view_") && k.endsWith("_human")),
      site_views_bot: count(d, (k) => k.startsWith("view_") && k.endsWith("_bot")),
      failed: rows.filter((r) => r.status === "failed").length,
    };
  };

  const month = store.paidRows(`${monthStart}T00:00:00.000Z`);
  const perService = new Map<string, { paid: number; revenue_usdc: number }>();
  for (const r of paidRows.filter((x) => x.day === day)) {
    const cur = perService.get(r.service_id) ?? { paid: 0, revenue_usdc: 0 };
    cur.paid += 1; cur.revenue_usdc += Number(r.price_usdc);
    perService.set(r.service_id, cur);
  }
  const todayByService = store.countersByService(day, iso(new Date(now.getTime() + DAY)));
  const quotesOf = (id: string) => todayByService.filter((r) => r.service_id === id && r.kind === "payment_required").reduce((a, r) => a + Number(r.n), 0);
  const samplesOf = (id: string) => todayByService.filter((r) => r.service_id === id && r.kind === "free_sample").reduce((a, r) => a + Number(r.n), 0);

  const pages = PAGE_GROUPS.map((page) => ({
    page,
    human: todayByService.filter((r) => r.service_id === SITE_COUNTER && r.kind === `view_${page}_human`).reduce((a, r) => a + Number(r.n), 0),
    bot: todayByService.filter((r) => r.service_id === SITE_COUNTER && r.kind === `view_${page}_bot`).reduce((a, r) => a + Number(r.n), 0),
  }));

  const spent = store.upstreamSpendSince(day);
  const minutesToday = now.getUTCHours() * 60 + now.getUTCMinutes() + 1;
  return {
    generated_at: now.toISOString(),
    day,
    mode: { data_source: pipeline.dataSource, payments: env.PAYMENT_MODE },
    today: tiles(day),
    yesterday: tiles(yesterday),
    month: { revenue_usdc: round6(month.reduce((a, r) => a + Number(r.price_usdc), 0)), paid_calls: month.length },
    needs_attention: store.needsAttention().length,
    uptime_today_pct: Math.min(100, Math.round((store.minutesUp(day) / minutesToday) * 1000) / 10),
    budget: { daily_limit_usd: env.DATAFORSEO_DAILY_LIMIT_USD, daily_spent_usd: spent, monthly_limit_usd: env.DATAFORSEO_MONTHLY_LIMIT_USD, monthly_spent_usd: store.upstreamSpendSince(monthStart) },
    hourly: hourly.map((h) => ({ hour: h.hour, requests: h.requests, paid: h.paid, revenue_usdc: round6(h.revenue_usdc) })),
    hourly_yesterday_revenue: hourlyYesterday.map((h) => round6(h.revenue_usdc)),
    by_service: pipeline.services
      .map((s) => ({ id: s.id, paid: perService.get(s.id)?.paid ?? 0, revenue_usdc: round6(perService.get(s.id)?.revenue_usdc ?? 0), quotes: quotesOf(s.id), free_samples: samplesOf(s.id) }))
      .filter((s) => s.paid || s.quotes || s.free_samples)
      .sort((a, b) => b.revenue_usdc - a.revenue_usdc || b.paid - a.paid || b.quotes - a.quotes),
    pages,
    recent: store.recentRequests(14).map((r) => ({
      id: r.id, time: r.created_at, service: r.service_id, status: r.status, price_usdc: r.price_usdc, paid: Boolean(r.paid),
      real: r.network === "eip155:8453", payer: r.payer ? `${r.payer.slice(0, 6)}…${r.payer.slice(-4)}` : null, source: r.data_source, cached: Boolean(r.cache_hit), error: r.error_code,
    })),
  };
}
export type Live = ReturnType<typeof buildLive>;
