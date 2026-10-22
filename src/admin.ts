import { createHash, timingSafeEqual } from "node:crypto";
import express, { type RequestHandler, type Router } from "express";
import type { Env } from "./config/env.js";
import { FACILITATOR_FEE_USD } from "./config/services.js";
import { FailureThrottle } from "./lib/rateLimit.js";
import { today, type Store } from "./lib/store.js";
import type { Pipeline } from "./services/pipeline.js";

/**
 * Minimal internal monitoring at /admin (HTTP Basic auth). Disabled completely (404) unless ADMIN_PASSWORD is set.
 * Shows only aggregates plus the list of paid requests that failed (wallet addresses and tx hashes are public chain data).
 */
const digest = (v: string) => createHash("sha256").update(v).digest();

/** Constant-time check of both fields; never short-circuits on the first mismatch. */
export function credentialsMatch(header: string | undefined, user: string, password: string): boolean {
  if (!header?.startsWith("Basic ") || !password) return false;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const i = decoded.indexOf(":");
  const givenUser = i === -1 ? decoded : decoded.slice(0, i);
  const givenPass = i === -1 ? "" : decoded.slice(i + 1);
  const userOk = timingSafeEqual(digest(givenUser), digest(user));
  const passOk = timingSafeEqual(digest(givenPass), digest(password));
  return userOk && passOk && i !== -1;
}

const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const usd = (n: unknown) => Number(n ?? 0).toFixed(4);
const MAINNET = "eip155:8453";

/** Per service, this month, real money: revenue vs DataForSEO cost, plus reliability. Flags services that lose money or fail often. */
function margins(store: Store, pipeline: Pipeline) {
  const since = `${today().slice(0, 7)}-01`;
  const byId = new Map(store.serviceMargins(since).map((r) => [r.service_id, r]));
  return pipeline.services.map((s) => {
    const r = byId.get(s.id);
    const paid = r?.paid ?? 0;
    const revenue = r?.revenue_usdc ?? 0;
    const cost = r?.cost_usd ?? 0;
    const failedPct = paid ? ((r?.failed ?? 0) / paid) * 100 : 0;
    const avgCost = paid ? cost / paid : null;
    return {
      service_id: s.id,
      price_usdc: s.priceUsdc,
      paid,
      revenue_usdc: revenue,
      cost_usd: cost,
      margin_usd: revenue - cost,
      avg_cost_per_call_usd: avgCost,
      failed_pct: failedPct,
      flag: avgCost !== null && avgCost >= Number(s.priceUsdc) ? "cost >= price" : failedPct >= 10 ? "failure rate >= 10%" : "",
    };
  });
}

export function buildAdminStats(env: Env, store: Store, pipeline: Pipeline) {
  const period = (p: "day" | "month") => {
    const s = store.summary(p);
    const networks = s.perNetwork.map((r) => {
      const paid = Number(r.paid);
      const real = r.network === MAINNET;
      // Facilitator fee: first 1,000 settlements/month are free, so it is only estimated for the month view on mainnet.
      const fee = real && p === "month" ? Math.max(0, paid - 1000) * FACILITATOR_FEE_USD : 0;
      const revenue = Number(r.revenue_usdc);
      const cost = Number(r.upstream_cost_usd);
      return { ...r, real_money: real, approx_facilitator_fee_usd: fee, approx_margin_usd: real ? revenue - cost - fee : null };
    });
    return { since: s.since, totals: s.totals, per_service: s.perService, per_network: networks, counters: s.counters };
  };
  return {
    generated_at: new Date().toISOString(),
    mode: { data_source: pipeline.dataSource, payments: env.PAYMENT_MODE },
    budget: {
      daily_limit_usd: env.DATAFORSEO_DAILY_LIMIT_USD,
      daily_spent_usd: store.upstreamSpendSince(today()),
      monthly_limit_usd: env.DATAFORSEO_MONTHLY_LIMIT_USD,
      monthly_spent_usd: store.upstreamSpendSince(`${today().slice(0, 7)}-01`),
    },
    day: period("day"),
    month: period("month"),
    needs_attention: store.needsAttention(),
    margins: margins(store, pipeline),
    history: store.history(30),
    buyers: store.buyers(`${today().slice(0, 7)}-01`),
    services: pipeline.services.map((s) => ({ id: s.id, price_usdc: s.priceUsdc, enabled: pipeline.isEnabled(s) })),
  };
}

type Stats = ReturnType<typeof buildAdminStats>;

/** Inline SVG bar chart (no scripts): revenue bars with the DataForSEO cost as a narrower bar in front. Styled via admin.css classes. */
function chart(history: Stats["history"]): string {
  const w = 720;
  const h = 140;
  const max = Math.max(0.01, ...history.map((d) => Math.max(d.revenue_usdc, d.cost_usd)));
  const step = w / history.length;
  const y = (v: number) => (v / max) * (h - 10);
  const bars = history
    .map((d, i) => {
      const x = i * step;
      const title = `<title>${esc(d.day)}: revenue ${usd(d.revenue_usdc)} USDC, cost ${usd(d.cost_usd)} USD, ${d.paid} paid</title>`;
      return `<g>${title}<rect class="bar-rev" x="${(x + 1).toFixed(1)}" y="${(h - y(d.revenue_usdc)).toFixed(1)}" width="${(step - 2).toFixed(1)}" height="${y(d.revenue_usdc).toFixed(1)}"/><rect class="bar-cost" x="${(x + step * 0.25).toFixed(1)}" y="${(h - y(d.cost_usd)).toFixed(1)}" width="${(step * 0.5).toFixed(1)}" height="${y(d.cost_usd).toFixed(1)}"/></g>`;
    })
    .join("");
  return `<svg class="chart" viewBox="0 0 ${w} ${h + 18}" role="img" aria-label="Revenue and cost per day, last 30 days"><line class="axis" x1="0" y1="${h}" x2="${w}" y2="${h}"/>${bars}<text class="axis-label" x="0" y="${h + 14}">${esc(history[0]?.day)}</text><text class="axis-label" x="${w}" y="${h + 14}" text-anchor="end">${esc(history.at(-1)?.day)} · max ${max.toFixed(2)}</text></svg>
  <p class="fine"><span class="key key-rev"></span> revenue (USDC, settled) <span class="key key-cost"></span> DataForSEO cost (USD) · real money only</p>`;
}

function table(head: string[], rows: unknown[][]): string {
  if (!rows.length) return '<p class="fine">No data yet.</p>';
  return `<div class="tablewrap"><table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`)
    .join("")}</tbody></table></div>`;
}

function renderPage(env: Env, st: Stats): string {
  const section = (title: string, p: Stats["day"]) => `
  <h2>${esc(title)} <span class="fine">(since ${esc(p.since)}, UTC)</span></h2>
  <p>Requests: <strong>${esc(p.totals.requests)}</strong> · paid (settled): <strong>${esc(p.totals.paid)}</strong> · completed: ${esc(p.totals.completed)} · failed: ${esc(p.totals.failed)} · cache hits: ${esc(p.totals.cache_hits)}</p>
  <h3>Revenue, DataForSEO cost and approximate margin</h3>
  ${table(
    ["network", "data", "requests", "paid", "revenue USDC", "DataForSEO cost USD", "fee est. USD", "margin est. USD"],
    p.per_network.map((r) => [
      `${r.network}${r.real_money ? "" : " (test)"}`,
      r.data_source,
      r.requests,
      r.paid,
      usd(r.revenue_usdc),
      usd(r.upstream_cost_usd),
      usd(r.approx_facilitator_fee_usd),
      r.approx_margin_usd === null ? "n/a (no real money)" : usd(r.approx_margin_usd),
    ]),
  )}
  <h3>Calls per endpoint</h3>
  ${table(
    ["service", "requests", "paid", "completed", "failed", "revenue USDC", "cost USD"],
    (p.per_service as Record<string, unknown>[]).map((r) => [r.service_id, r.requests, r.paid, r.completed, r.failed, usd(r.revenue_usdc), usd(r.upstream_cost_usd)]),
  )}
  <h3>Events (no personal data)</h3>
  ${table(
    ["service", "event", "count"],
    (p.counters as Record<string, unknown>[]).map((r) => [r.service_id, r.kind, r.n]),
  )}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Admin – ${esc(env.SITE_NAME)}</title><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/admin.css"></head>
<body><header class="top"><div class="wrap bar"><span class="brand"><span class="mark"></span>${esc(env.SITE_NAME)} · admin</span><span class="fine">${esc(st.mode.payments)} · ${esc(st.mode.data_source)} data</span></div></header>
<main class="wrap">
  <p class="fine">Generated ${esc(st.generated_at)} · <a href="/admin/stats.json">stats.json</a></p>
  <h2>DataForSEO budget</h2>
  <p>Today: <strong>$${usd(st.budget.daily_spent_usd)}</strong> of $${esc(st.budget.daily_limit_usd)} · this month: <strong>$${usd(st.budget.monthly_spent_usd)}</strong> of $${esc(st.budget.monthly_limit_usd)}</p>
  <h2>Needs attention: failed delivery or payment outcome pending</h2>
  ${table(
    ["created", "service", "status", "error", "retries", "price USDC", "network", "payer", "tx", "request id"],
    st.needs_attention.map((r) => [r.created_at, r.service_id, r.status, r.error_code, r.retries, r.price_usdc, r.network, r.payer, r.tx_hash, r.id]),
  )}
  <h2>Last 30 days <span class="fine">(real money)</span></h2>
  ${chart(st.history)}
  <h2>Margin and reliability per service <span class="fine">(this month, real money)</span></h2>
  ${table(
    ["service", "price USDC", "paid", "revenue USDC", "cost USD", "margin", "avg cost / call", "failed %", "flag"],
    st.margins.map((m) => [m.service_id, m.price_usdc, m.paid, usd(m.revenue_usdc), usd(m.cost_usd), usd(m.margin_usd), m.avg_cost_per_call_usd === null ? "–" : usd(m.avg_cost_per_call_usd), m.failed_pct.toFixed(1), m.flag]),
  )}
  <h2>Buyers <span class="fine">(this month, by wallet address)</span></h2>
  <p>Buyers: <strong>${esc(st.buyers.buyers)}</strong> · repeat buyers (2+ paid calls): <strong>${esc(st.buyers.repeat_buyers)}</strong></p>
  ${table(["wallet", "paid calls", "USDC", "last seen"], st.buyers.top.map((b) => [b.payer, b.calls, usd(b.usdc), b.last_seen]))}
  <p class="fine">Bookkeeping export: <a href="/admin/payments.csv">payments of this month (CSV)</a> · another month: /admin/payments.csv?month=YYYY-MM</p>
  ${section("Today", st.day)}
  ${section("This month", st.month)}
  <h2>Services</h2>
  ${table(["service", "price USDC", "enabled"], st.services.map((s) => [s.id, s.price_usdc, s.enabled ? "yes" : "no"]))}
</main></body></html>`;
}

export function createAdminRouter(deps: { env: Env; store: Store; pipeline: Pipeline }): Router {
  const { env, store, pipeline } = deps;
  const router = express.Router();

  // Disabled (looks like any unknown path) unless a password is configured: no open admin interface, ever.
  const enabled: RequestHandler = (_req, res, next) => (env.ADMIN_PASSWORD ? next() : void res.status(404).json({ error: "not_found" }));
  // Password guessing: only FAILED attempts count; 10 failures per minute block that client address (even with the right password).
  const failures = new FailureThrottle(10);
  const auth: RequestHandler = (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    if (failures.blocked(req.ip)) {
      res.setHeader("Retry-After", "60");
      return void res.status(429).json({ error: "too_many_attempts" });
    }
    if (credentialsMatch(req.get("authorization"), env.ADMIN_USER, env.ADMIN_PASSWORD)) return next();
    failures.fail(req.ip);
    res.setHeader("WWW-Authenticate", 'Basic realm="admin", charset="UTF-8"');
    res.status(401).json({ error: "unauthorized" });
  };
  router.use(enabled, auth);

  router.get("/", (_req, res) => {
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    res.type("html").send(renderPage(env, buildAdminStats(env, store, pipeline)));
  });
  router.get("/payments.csv", (req, res) => {
    const asked = typeof req.query.month === "string" ? req.query.month : "";
    const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(asked) ? asked : today().slice(0, 7);
    // Cells that could be read as spreadsheet formulas are prefixed; all values here are ours or hex/ids anyway.
    const cell = (v: unknown) => {
      const t = String(v ?? "");
      return /^[=+\-@\t\r]/.test(t) ? `"'${t.replace(/"/g, '""')}"` : /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    const rows = store.paymentsOfMonth(month).map((r) => [r.created_at, r.service_id, r.price_usdc, "USDC", r.network, r.payer, r.tx_hash, r.status].map(cell).join(","));
    res.setHeader("Content-Disposition", `attachment; filename="payments-${month}.csv"`);
    res.type("text/csv").send(["time_utc,service,amount,asset,network,payer,tx_hash,status", ...rows].join("\n") + "\n");
  });
  router.get("/stats.json", (_req, res) => {
    res.json(buildAdminStats(env, store, pipeline));
  });
  return router;
}
