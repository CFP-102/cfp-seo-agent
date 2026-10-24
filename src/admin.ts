import { createHash, timingSafeEqual } from "node:crypto";
import express, { type RequestHandler, type Router } from "express";
import type { Env } from "./config/env.js";
import { FACILITATOR_FEE_USD } from "./config/services.js";
import { buildInsights } from "./adminInsights.js";
import { liveSnapshots, type Live } from "./adminLive.js";
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
    wishes: store.recentWishes(50),
    history: store.history(30),
    buyers: store.buyers(`${today().slice(0, 7)}-01`),
    services: pipeline.services.map((s) => ({ id: s.id, price_usdc: s.priceUsdc, enabled: pipeline.isEnabled(s) })),
  };
}

type Stats = ReturnType<typeof buildAdminStats>;

/** Inline SVG bar chart (no scripts): revenue bars with the DataForSEO cost as a narrower bar in front. Styled via admin.css classes. */
function chart(history: Stats["history"]): string {
  const w = 1000;
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

type CellObj = { t: string | number | null | undefined; c?: string; title?: string };
type Cell = string | number | null | undefined | CellObj;
const norm = (c: Cell): CellObj => (c !== null && typeof c === "object" ? c : { t: c });

const looksNumeric = (v: unknown) => /^-?\$?\d[\d.,]*%?$/.test(String(v ?? ""));
const short = (v: string | null | undefined) => (v && v.length > 18 ? `${v.slice(0, 8)}…${v.slice(-6)}` : v);
/** Wallet address / hash / id cell: shortened, full value on hover and in search. */
const mono = (v: string | null | undefined): Cell => ({ t: short(v) ?? "", c: "mono", title: v ?? "" });
const tag = (v: string, c: string): Cell => (v ? { t: v, c: `tag ${c}` } : "");

function table(head: string[], rows: Cell[][]): string {
  if (!rows.length) return '<p class="empty">No data yet.</p>';
  const cell = (c: Cell) => {
    const o = norm(c);
    const cls = [o.c ?? "", looksNumeric(o.t) ? "num" : ""].filter(Boolean).join(" ");
    return `<td${cls ? ` class="${esc(cls)}"` : ""}${o.title ? ` title="${esc(o.title)}"` : ""}>${esc(o.t)}</td>`;
  };
  return `<div class="tablewrap"><table class="sortable"><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows
    .map((r) => `<tr data-search="${esc(r.map((c) => { const o = norm(c); return `${o.t ?? ""} ${o.title ?? ""}`; }).join(" ").toLowerCase())}">${r.map(cell).join("")}</tr>`)
    .join("")}</tbody></table></div>`;
}

/** Collapsible panel (native <details>, works without scripts). */
function panel(title: string, body: string, opts: { open?: boolean; badge?: string; tone?: "bad" | "warn" | "" } = {}): string {
  const badge = opts.badge ? `<span class="badge ${opts.tone ?? ""}">${esc(opts.badge)}</span>` : "";
  return `<details class="panel"${opts.open === false ? "" : " open"}><summary><span class="chev"></span><span class="ptitle">${esc(title)}</span>${badge}</summary><div class="pbody">${body}</div></details>`;
}

function kpi(label: string, value: string, sub = "", tone = ""): string {
  return `<div class="kpi ${tone}"><span class="klabel">${esc(label)}</span><span class="kvalue">${esc(value)}</span><span class="ksub">${esc(sub)}</span></div>`;
}

/** Budget meter as inline SVG (animated by CSS, no inline styles). */
function meter(label: string, spent: number, limit: number): string {
  const pct = limit > 0 ? Math.min(100, (spent / limit) * 100) : 0;
  const level = pct >= 100 ? "bad" : pct >= 80 ? "warn" : "ok";
  return `<div class="meterrow"><div class="meterhead"><span>${esc(label)}</span><span><strong>$${usd(spent)}</strong> of $${esc(limit)} · ${pct.toFixed(0)}%</span></div><svg class="meter" viewBox="0 0 100 6" preserveAspectRatio="none" role="img" aria-label="${esc(label)} ${pct.toFixed(0)} percent"><rect class="meter-bg" width="100" height="6"/><rect class="meter-fill ${level}" width="${pct.toFixed(1)}" height="6"/></svg></div>`;
}


/** Live panel (server-rendered first, then refreshed by admin.js every few seconds). Numbers carry data-v for the count-up animation. */
const TILE_DEFS: { key: keyof Live["today"]; label: string; unit?: "usdc" | "usd"; good?: "up" | "down" }[] = [
  { key: "revenue_usdc", label: "Revenue", unit: "usdc" },
  { key: "paid_calls", label: "Paid calls" },
  { key: "buyers", label: "Buyers" },
  { key: "new_buyers", label: "New buyers" },
  { key: "requests", label: "Requests (all)" },
  { key: "margin_usd", label: "Margin after all API cost", unit: "usd" },
  { key: "upstream_cost_usd", label: "DataForSEO cost (all)", unit: "usd", good: "down" },
  { key: "quotes", label: "Price quotes (402)" },
  { key: "free_samples", label: "Free samples" },
  { key: "mcp_calls", label: "MCP calls" },
  { key: "site_views_human", label: "Website visits" },
  { key: "site_views_bot", label: "Bot / crawler visits" },
  { key: "failed", label: "Failed paid calls", good: "down" },
];
/** Money with three decimals, counts as whole numbers (the same rule as fmt() in admin.js). */
const fmtTile = (v: number, unit?: string) => (unit ? v.toFixed(3) : String(Math.round(v)));

function livePanel(live: Live): string {
  const tile = (d: (typeof TILE_DEFS)[number]) => {
    const v = Number(live.today[d.key]);
    const y = Number(live.yesterday[d.key]);
    return `<div class="ltile" data-key="${d.key}"><span class="klabel">${esc(d.label)}</span><span class="lval${d.unit ? " dec" : ""}" data-v="${v}">${esc(fmtTile(v, d.unit))}</span><span class="lsub" data-y="${y}" data-good="${d.good ?? "up"}">yesterday ${esc(fmtTile(y, d.unit))}</span></div>`;
  };
  const peak = Math.max(0.0001, ...live.hourly.map((h) => h.revenue_usdc), ...live.hourly_yesterday_revenue);
  const bars = live.hourly
    .map((h, i) => {
      const hh = (h.revenue_usdc / peak) * 56;
      const rq = Math.min(56, h.requests * 4);
      return `<g class="hr" data-hour="${i}"><title>${String(i).padStart(2, "0")}:00 UTC: ${usd(h.revenue_usdc)} USDC, ${h.paid} paid, ${h.requests} requests</title><rect class="hq" x="${i * 12 + 1}" y="${(60 - rq).toFixed(1)}" width="10" height="${rq.toFixed(1)}"/><rect class="hp" x="${i * 12 + 1}" y="${(60 - hh).toFixed(1)}" width="10" height="${hh.toFixed(1)}"/></g>`;
    })
    .join("");
  return `<section id="live" class="live" aria-label="Live overview">
  <div class="lstrip">
    <span class="livebadge"><span class="dot"></span>LIVE</span>
    <span class="lclock" id="lclock">${esc(live.generated_at.slice(11, 19))} UTC</span>
    <span class="fine" id="lupdated">updated just now</span>
    <svg class="ring" viewBox="0 0 20 20" role="img" aria-label="Next refresh"><circle class="ring-bg" cx="10" cy="10" r="8"/><circle class="ring-fg" id="lring" cx="10" cy="10" r="8"/></svg>
    <span class="lspacer"></span>
    <span class="pill">${esc(live.mode.payments)}</span><span class="pill">${esc(live.mode.data_source)} data</span>
    <span class="pill" id="luptime">uptime today ${esc(live.uptime_today_pct)} %</span>
    <span class="pill ${live.needs_attention ? "alert" : ""}" id="lattention">${live.needs_attention ? `${live.needs_attention} need attention` : "all clear"}</span>
  </div>
  <div class="lhero">
    <div class="lbig"><span class="klabel">Revenue today, UTC day (USDC, settled)</span><span class="lbigval" id="lbigval" data-v="${live.today.revenue_usdc}">${esc(live.today.revenue_usdc.toFixed(3))}</span>
      <span class="lsub" id="lbigsub">this month ${esc(live.month.revenue_usdc.toFixed(3))} USDC · ${esc(live.month.paid_calls)} paid calls</span></div>
    <div class="lchart"><span class="klabel">Today by hour (UTC): revenue bars, requests behind</span>
      <svg class="hourly" id="lhourly" viewBox="0 0 288 60" preserveAspectRatio="none" role="img" aria-label="Revenue and requests per hour today">${bars}</svg>
      <div class="hlabels"><span>00</span><span>06</span><span>12</span><span>18</span><span>23</span></div></div>
  </div>
  <div class="ltiles" id="ltiles">${TILE_DEFS.map(tile).join("")}</div>
  <div class="lcols">
    <div class="lbox"><h3>Live feed</h3><ul class="feed" id="lfeed">${live.recent.map(feedItem).join("") || '<li class="empty">No requests yet.</li>'}</ul></div>
    <div class="lbox"><h3>Today by service</h3><div id="lservices">${liveServices(live)}</div><h3>Website visits today</h3><div id="lpages">${livePages(live)}</div></div>
  </div>
  <noscript><p class="fine">Enable JavaScript for the live refresh. The numbers above are from the page load.</p></noscript>
</section>`;
}
function feedItem(r: Live["recent"][number]): string {
  const kind = r.paid ? (r.real ? "paid" : "test") : r.price_usdc === 0 ? "free" : "other";
  const label = kind === "paid" ? `${usd(r.price_usdc)} USDC` : kind === "test" ? "testnet" : "free";
  return `<li class="fi ${kind} ${r.status === "failed" ? "fail" : ""}" data-id="${esc(r.id)}"><span class="ft">${esc(r.time.slice(11, 19))}</span><span class="fs">${esc(r.service)}</span><span class="fp">${esc(label)}</span><span class="fw">${esc(r.payer ?? "")}</span><span class="fst">${esc(r.status)}${r.cached ? " · cache" : ""}${r.error ? ` · ${esc(r.error)}` : ""}</span></li>`;
}
function liveServices(live: Live): string {
  if (!live.by_service.length) return '<p class="empty">Nothing yet today.</p>';
  const max = Math.max(1, ...live.by_service.map((s) => s.quotes + s.paid + s.free_samples));
  return live.by_service.map((s) => `<div class="srow"><span class="sname">${esc(s.id)}</span><svg class="sbar" viewBox="0 0 100 6" preserveAspectRatio="none" aria-hidden="true"><rect class="sb-q" width="${(((s.quotes + s.paid + s.free_samples) / max) * 100).toFixed(1)}" height="6"/><rect class="sb-p" width="${((s.paid / max) * 100).toFixed(1)}" height="6"/></svg><span class="snum">${s.paid} paid · ${s.quotes} quotes · ${s.free_samples} free · ${usd(s.revenue_usdc)}</span></div>`).join("");
}
function livePages(live: Live): string {
  const rows = live.pages.filter((p) => p.human || p.bot);
  if (!rows.length) return '<p class="empty">No page views counted yet today.</p>';
  return `<div class="tablewrap"><table><thead><tr><th>page</th><th>visitors</th><th>bots</th></tr></thead><tbody>${rows.map((p) => `<tr><td>${esc(p.page)}</td><td class="num">${p.human}</td><td class="num">${p.bot}</td></tr>`).join("")}</tbody></table></div>`;
}

function renderPage(env: Env, st: Stats, liveData: Live): string {
  const realSum = (p: Stats["day"], k: "revenue_usdc" | "paid" | "approx_margin_usd") =>
    p.per_network.filter((r) => r.real_money).reduce((a, r) => a + Number((r as Record<string, unknown>)[k] ?? 0), 0);
  const section = (p: Stats["day"]) => `
  <p class="line">Requests <strong>${esc(p.totals.requests)}</strong> · paid (settled) <strong>${esc(p.totals.paid)}</strong> · completed ${esc(p.totals.completed)} · failed ${esc(p.totals.failed)} · cache hits ${esc(p.totals.cache_hits)} <span class="fine">· since ${esc(p.since)} UTC</span></p>
  <h3>Revenue, DataForSEO cost and approximate margin</h3>
  ${table(
    ["network", "data", "requests", "paid", "revenue USDC", "DataForSEO cost USD", "fee est. USD", "margin est. USD"],
    p.per_network.map((r) => [
      r.real_money ? r.network : { t: `${r.network} (test)`, c: "muted" },
      r.data_source,
      r.requests,
      r.paid,
      usd(r.revenue_usdc),
      usd(r.upstream_cost_usd),
      usd(r.approx_facilitator_fee_usd),
      r.approx_margin_usd === null ? { t: "n/a (no real money)", c: "muted" } : usd(r.approx_margin_usd),
    ]),
  )}
  <h3>Calls per endpoint</h3>
  ${table(
    ["service", "requests", "paid", "completed", "failed", "revenue USDC", "cost USD"],
    (p.per_service as Record<string, unknown>[]).map((r) => [r.service_id as string, r.requests as number, r.paid as number, r.completed as number, r.failed as number, usd(r.revenue_usdc), usd(r.upstream_cost_usd)]),
  )}
  <h3>Events (no personal data)</h3>
  ${table(
    ["service", "event", "count"],
    (p.counters as Record<string, unknown>[]).map((r) => [r.service_id as string, r.kind as string, r.n as number]),
  )}`;

  const attention = st.needs_attention.length;
  const flagged = st.margins.filter((m) => m.flag).length;
  const monthMargin = realSum(st.month, "approx_margin_usd");
  const group = (id: string, title: string, intro: string, panels: string[]) => `<section id="${id}" class="group"><h2>${esc(title)}</h2><p class="fine group-intro">${esc(intro)}</p>${panels.join("\n")}</section>`;

  const money = group("money", "Money", "Revenue, margin and buyers. Real money only; own test wallets are hidden.", [
    `<div class="kpis">
      ${kpi("Revenue this month", `${usd(realSum(st.month, "revenue_usdc"))} USDC`, `${realSum(st.month, "paid")} paid calls`)}
      ${kpi("Margin this month", `$${usd(monthMargin)}`, "revenue − DataForSEO − fee", monthMargin < 0 ? "bad" : "")}
      ${kpi("Buyers this month", String(st.buyers.buyers), `${st.buyers.repeat_buyers} repeat`)}
    </div>`,
    panel("Last 30 days", chart(st.history) + `<p class="fine">Hover a bar for the numbers.</p>`),
    panel(
      "Margin and reliability per service",
      `<p class="fine">This month, real money. A service is flagged when its average DataForSEO cost reaches the price or 10% or more of paid calls failed.</p>` +
        table(
          ["service", "price USDC", "paid", "revenue USDC", "cost USD", "margin", "avg cost / call", "failed %", "flag"],
          st.margins.map((m) => [
            m.service_id,
            m.price_usdc,
            m.paid,
            usd(m.revenue_usdc),
            usd(m.cost_usd),
            { t: usd(m.margin_usd), c: m.margin_usd < 0 ? "negative" : "" },
            m.avg_cost_per_call_usd === null ? "–" : usd(m.avg_cost_per_call_usd),
            m.failed_pct.toFixed(1),
            tag(m.flag, "bad"),
          ]),
        ),
      { badge: flagged ? `${flagged} flagged` : "", tone: flagged ? "warn" : "" },
    ),
    panel(
      "Buyers",
      `<p class="line">Buyers <strong>${esc(st.buyers.buyers)}</strong> · repeat buyers (2+ paid calls) <strong>${esc(st.buyers.repeat_buyers)}</strong> <span class="fine">· this month, by wallet address</span></p>` +
        table(["wallet", "paid calls", "USDC", "last seen"], st.buyers.top.map((b) => [mono(b.payer), b.calls, usd(b.usdc), b.last_seen])) +
        `<p class="fine"><a href="/admin/payments.csv">Download this month as CSV</a> · other month: /admin/payments.csv?month=YYYY-MM</p>`,
    ),
    panel("This month", section(st.month), { open: false }),
  ]);

  const traffic = group("traffic", "Traffic", "Who looks, who asks, who buys: website visits, price quotes, free samples, MCP use. Counters only, no IP addresses.", [
    panel(
      "Trends (live, 30 days)",
      `<p class="fine">Daily counters and 7-day comparisons. Website visits are counted anonymously per page group (browser or bot guess). Updates every 60 seconds. <span id="ins-updated"></span></p>
      <div id="ins-kpis" class="kpis"></div>
      <div id="ins-charts" class="ins-charts"></div>
      <h3>Services, last 7 days</h3><div id="ins-services"></div>
      <h3>Requested locations, last 30 days</h3><div id="ins-locations"></div>
      <noscript><p class="fine">Enable JavaScript for live trends, or open <a href="/admin/insights.json">insights.json</a>.</p></noscript>`,
    ),
    panel("Wishlist", `<p class="fine">What visitors would pay for (latest 50, untrusted text from the public, shown escaped).</p>` + table(["time", "wish"], st.wishes.map((w) => [w.created_at, w.text])), { open: false, badge: st.wishes.length ? String(st.wishes.length) : "" }),
    panel("Today", section(st.day), { open: false }),
  ]);

  const operations = group("operations", "Operations", "Failed payments to check, the DataForSEO budget and the service list.", [
    panel(
      "Needs attention",
      `<p class="fine">Failed delivery or payment outcome pending. Candidates for a refund or a manual check against the chain.</p>` +
        table(
          ["created", "service", "status", "error", "retries", "price USDC", "network", "payer", "tx", "request id"],
          st.needs_attention.map((r) => [r.created_at as string, r.service_id as string, tag(String(r.status ?? ""), "bad"), r.error_code as string, r.retries as number, r.price_usdc as number, r.network as string, mono(r.payer as string), mono(r.tx_hash as string), mono(r.id as string)]),
        ),
      { badge: attention ? String(attention) : "all clear", tone: attention ? "bad" : "" },
    ),
    panel("DataForSEO budget", meter("Today", st.budget.daily_spent_usd, st.budget.daily_limit_usd) + meter("This month", st.budget.monthly_spent_usd, st.budget.monthly_limit_usd)),
    panel("Services", table(["service", "price USDC", "enabled"], st.services.map((s) => [s.id, s.price_usdc, s.enabled ? tag("yes", "ok") : tag("no", "bad")])), { open: false }),
  ]);

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Admin – ${esc(env.SITE_NAME)}</title><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/admin.css"><script src="/admin.js" defer></script></head>
<body class="admin"><header class="top"><div class="wrap bar"><span class="brand"><img src="/logo-white.png" alt="Chiemgau Films" width="62" height="30"><span class="brandname">${esc(env.SITE_NAME)} · admin</span></span>
<nav class="anchors" aria-label="Sections"><a href="#live">Live</a><a href="#money">Money</a><a href="#traffic">Traffic</a><a href="#operations">Operations</a></nav></div></header>
<main class="wrap wide">
  ${livePanel(liveData)}
  <div class="toolbar">
    <input id="q" type="search" placeholder="Search all tables: service, wallet, tx, status …" autocomplete="off" aria-label="Search tables">
    <span id="qcount" class="fine"></span>
    <button type="button" id="expand">Expand all</button><button type="button" id="collapse">Collapse all</button>
    <span class="fine">Generated ${esc(st.generated_at)} · <a href="/admin/stats.json">stats.json</a> · <a href="/admin/live.json">live.json</a></span>
  </div>
  ${money}
  ${traffic}
  ${operations}
</main></body></html>`;
}

export function createAdminRouter(deps: { env: Env; store: Store; pipeline: Pipeline; beforeRead?: () => void }): Router {
  const { env, store, pipeline } = deps;
  const live = liveSnapshots(env, store, pipeline);
  const fresh = () => deps.beforeRead?.();
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
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    fresh();
    res.type("html").send(renderPage(env, buildAdminStats(env, store, pipeline), live()));
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
  router.get("/live.json", (_req, res) => {
    fresh();
    res.json(live());
  });
  router.get("/insights.json", (_req, res) => {
    fresh();
    res.json(buildInsights(env, store, pipeline));
  });
  router.get("/stats.json", (_req, res) => {
    res.json(buildAdminStats(env, store, pipeline));
  });
  return router;
}
