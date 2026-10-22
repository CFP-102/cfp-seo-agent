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
    services: pipeline.services.map((s) => ({ id: s.id, price_usdc: s.priceUsdc, enabled: pipeline.isEnabled(s) })),
  };
}

type Stats = ReturnType<typeof buildAdminStats>;

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
  router.get("/stats.json", (_req, res) => {
    res.json(buildAdminStats(env, store, pipeline));
  });
  return router;
}
