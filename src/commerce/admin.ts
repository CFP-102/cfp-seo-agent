import { randomBytes, timingSafeEqual } from "node:crypto";
import express, { type RequestHandler, type Router } from "express";
import type { Env } from "../config/env.js";
import { MAX_MARKUP_BPS } from "../config/commerce.js";
import { esc, kpi, mono, panel, table, tag } from "../adminUi.js";
import type { Store } from "../lib/store.js";
import { today } from "../lib/store.js";
import type { Commerce } from "./index.js";
import { FINANCE_DIRECTORY } from "./finance.js";
import { formatMicro } from "./money.js";
import { formatBps } from "./pricing.js";

/**
 * Admin area "Commerce" at /admin/commerce (behind the admin login of src/admin.ts).
 * Everyone logged in may look; only the owner role may change the markup, the kill switch or an order.
 * Changes are plain HTML form posts, protected against cross-site requests by an Origin check plus a form token,
 * and written to the audit log.
 */
export type AdminRole = "owner" | "viewer";

const usd = (micro: number) => formatMicro(BigInt(micro), 6).replace(/0{4}$/, "");
const TX = /^0x[0-9a-fA-F]{64}$/;

export function createCommerceAdmin(deps: { env: Env; store: Store; commerce: Commerce }): Router {
  const { env, store, commerce } = deps;
  const { cstore, giftcards } = commerce;
  const router = express.Router();
  // Random per process (a restart invalidates open forms); not derived from the password, so a leaked page reveals nothing.
  const formToken = randomBytes(32).toString("hex");
  const origin = new URL(env.PUBLIC_BASE_URL).origin;

  const role = (res: express.Response): AdminRole => (res.locals.adminRole === "owner" ? "owner" : "viewer");
  const ownerOnly: RequestHandler = (req, res, next) => {
    if (role(res) !== "owner") return void res.status(403).json({ error: "forbidden", message: "Read-only admin role." });
    // Basic auth is sent by the browser automatically, so a foreign page could submit a form: require our origin and the form token.
    const sent = String((req.body as Record<string, unknown> | undefined)?.token ?? "");
    const okToken = sent.length === formToken.length && timingSafeEqual(Buffer.from(sent), Buffer.from(formToken));
    if (req.get("origin") !== origin || !okToken) return void res.status(403).json({ error: "forbidden", message: "Form origin or token invalid." });
    next();
  };
  const form = express.urlencoded({ extended: false, limit: "4kb", parameterLimit: 10 });
  const back = (res: express.Response, note: string) => res.redirect(303, `/admin/commerce?note=${encodeURIComponent(note)}`);
  const actor = (res: express.Response) => `${role(res)}`;

  router.get("/", (req, res) => {
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    const note = typeof req.query.note === "string" ? req.query.note.slice(0, 80) : "";
    res.type("html").send(render(role(res), note));
  });

  router.post("/settings", form, ownerOnly, (req, res) => {
    const body = req.body as Record<string, string>;
    const pct = String(body.markup_percent ?? "").trim().replace(",", ".");
    if (!/^\d{1,2}(\.\d{1,2})?$/.test(pct)) return back(res, "Markup not changed: enter a percentage like 3.5");
    const bps = Math.round(Number(pct) * 100);
    if (bps < 0 || bps > MAX_MARKUP_BPS) return back(res, `Markup not changed: allowed 0 to ${MAX_MARKUP_BPS / 100} %`);
    if (bps !== cstore.markupBps()) cstore.setSetting("markup_bps", String(bps), actor(res));
    const paused = body.paused === "1";
    if (paused !== cstore.paused()) cstore.setSetting("paused", paused ? "1" : "0", actor(res));
    back(res, "Saved");
  });

  router.post("/orders/:id/retry", form, ownerOnly, async (req, res) => {
    const ok = await giftcards.redeliver(String(req.params.id), actor(res));
    back(res, ok ? "Delivered" : "Delivery not possible (status or supplier)");
  });

  router.post("/orders/:id/refunded", form, ownerOnly, (req, res) => {
    const tx = String((req.body as Record<string, string>).refund_tx ?? "").trim();
    if (!TX.test(tx)) return back(res, "Refund not recorded: enter the refund transaction hash (0x + 64 hex)");
    const id = String(req.params.id);
    if (!cstore.refunded(id, tx.toLowerCase())) return back(res, "Refund not recorded: order is not waiting for a refund");
    cstore.audit(actor(res), "refunded", `${id} ${tx}`);
    back(res, "Refund recorded");
  });

  function render(r: AdminRole, note: string): string {
    const month = cstore.stats(`${today().slice(0, 7)}-01`);
    const all = cstore.stats("0000");
    const info = giftcards.info();
    const orders = cstore.recentOrders(30);
    const counters = (store.stats("month").counters as { service_id: string; kind: string; n: number }[]).filter((c) => c.service_id === "giftcards");
    const failedPayments = counters.filter((c) => c.kind === "settle_failed" || c.kind === "invalid_payment").reduce((a, c) => a + Number(c.n), 0);
    const owner = r === "owner";
    const hidden = `<input type="hidden" name="token" value="${esc(formToken)}">`;
    const attention = orders.filter((o) => o.status === "refund_pending" || o.status === "settlement_uncertain");

    const kpis = `<div class="kpis">
      ${kpi("Orders (month)", String(month.orders), `${all.orders} all time`)}
      ${kpi("Payment volume (month)", `${usd(month.volume_micro!)} USDC`, `${month.paid} settled payments`)}
      ${kpi("Purchase cost (delivered)", `$${usd(month.cost_micro!)}`)}
      ${kpi("Markup earned", `$${usd(month.markup_micro!)}`)}
      ${kpi("Contribution", `$${usd(month.contribution_micro!)}`, "sale − cost − payment fee", month.contribution_micro! < 0 ? "bad" : "")}
      ${kpi("Failed payments (month)", String(failedPayments), "refused or not settled", failedPayments ? "warn" : "")}
      ${kpi("Open orders", String(month.open), `${month.uncertain} payment unclear`, month.uncertain ? "warn" : "")}
      ${kpi("Refunds", String(month.refund_pending), `${month.refunded} refunded`, month.refund_pending ? "bad" : "")}
      ${kpi("Finance referrals", "0", "directory only, no tracking")}
      ${kpi("Partner commissions", "0", "no partner agreement")}
    </div>`;

    const settings = owner
      ? `<form method="post" action="/admin/commerce/settings" class="tester">${hidden}
          <label class="field small"><span>Markup in % (0 to ${MAX_MARKUP_BPS / 100})</span><input name="markup_percent" type="text" inputmode="decimal" value="${esc(formatBps(cstore.markupBps()))}" required></label>
          <label class="check"><input type="checkbox" name="paused" value="1"${info.paused ? " checked" : ""}><span>Kill switch: pause all new gift card purchases</span></label>
          <div class="cta"><button type="submit" class="btn primary">Save</button></div>
        </form><p class="fine">Changes apply to new quotes. Existing quotes keep their price until they expire (${esc(info.quote_ttl_seconds)} s).</p>`
      : `<p class="line">Markup <strong>${esc(formatBps(cstore.markupBps()))} %</strong> · purchases ${info.paused ? "paused" : "running"} <span class="fine">· read-only role</span></p>`;

    const orderRows = orders.map((o) => [
      o.created_at,
      tag(o.status, o.status === "delivered" ? "ok" : o.status === "refunded" ? "" : "bad"),
      o.data_source,
      o.product_id,
      `${o.face_value} ${o.currency}`,
      usd(o.sale_micro),
      usd(o.cost_micro),
      usd(o.markup_micro),
      usd(o.sale_micro - o.cost_micro - o.payment_fee_micro),
      mono(o.payer),
      mono(o.tx_hash),
      o.error_code ?? "",
      mono(o.id),
    ]);

    const actions = owner && attention.length
      ? attention
          .map((o) => `<div class="buybox"><p><strong>${esc(o.status)}</strong> · order <code>${esc(o.id)}</code> · ${esc(usd(o.sale_micro))} USDC · payer <code>${esc(o.payer ?? "–")}</code> · tx <code>${esc(o.tx_hash ?? "none")}</code></p>
            ${o.status === "refund_pending" ? `<form method="post" action="/admin/commerce/orders/${esc(o.id)}/retry">${hidden}<button type="submit" class="btn">Retry delivery (same supplier order, never a second card)</button></form>` : ""}
            <form method="post" action="/admin/commerce/orders/${esc(o.id)}/refunded">${hidden}<label class="field"><span>Refund sent to the payer: transaction hash</span><input name="refund_tx" type="text" pattern="0x[0-9a-fA-F]{64}" required autocomplete="off"></label><button type="submit" class="btn">Record refund</button></form></div>`)
          .join("")
      : "";

    const directory = table(["provider", "category", "regions", "relationship", "last checked"], FINANCE_DIRECTORY.map((e) => [e.name, e.category, e.products.flatMap((p) => p.regions).join(", "), e.relationship, e.last_checked]));

    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Commerce – ${esc(env.SITE_NAME)}</title><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/admin.css"><script src="/admin.js" defer></script></head>
<body class="admin"><header class="top"><div class="wrap bar"><span class="brand"><img src="/logo-white.png" alt="Chiemgau Films" width="62" height="30"><span class="brandname">${esc(env.SITE_NAME)} · commerce</span></span>
<nav class="anchors" aria-label="Sections"><a href="/admin">Data API</a><a href="#giftcards">Gift cards</a><a href="#finance">Finance</a><a href="#audit">Audit log</a></nav></div></header>
<main class="wrap wide">
  ${note ? `<p class="note" role="status">${esc(note)}</p>` : ""}
  <section id="giftcards" class="group"><h2>Agent Gift Cards</h2>
  <p class="fine group-intro">Module ${info.enabled ? "on" : "off"} · supplier ${esc(info.provider)}${info.test_mode ? " (test supplier, worthless codes)" : ""} · payments ${esc(env.PAYMENT_MODE)} · max ${esc(info.max_order_usdc)} USDC per order · daily limit ${esc(env.GIFTCARDS_DAILY_LIMIT_USD)} USD · ${esc(env.GIFTCARDS_PAYER_DAILY_ORDERS)} orders per wallet and day. Codes are never shown here.</p>
  ${kpis}
  ${panel("Markup and kill switch", settings)}
  ${panel("Needs attention", (actions || (attention.length ? table(["order", "status"], attention.map((o) => [mono(o.id), o.status])) : '<p class="empty">Nothing to do.</p>')), { badge: attention.length ? String(attention.length) : "all clear", tone: attention.length ? "bad" : "" })}
  ${panel("Latest orders", `<p class="fine">Amounts in USD/USDC. Contribution = sale price − purchase cost − payment fee.</p>` + table(["created", "status", "data", "product", "face value", "sale", "cost", "markup", "contribution", "payer", "tx", "error", "order id"], orderRows))}
  ${panel("Events this month", table(["event", "count"], counters.map((c) => [c.kind, c.n])), { open: false })}
  </section>
  <section id="finance" class="group"><h2>Agent Finance Gateway</h2><p class="fine group-intro">Directory only: no referral tracking, no fees, no partnership. Entries live in src/commerce/finance.ts.</p>${panel("Directory", directory)}</section>
  <section id="audit" class="group"><h2>Audit log</h2>${panel("Latest changes", table(["time", "role", "action", "detail"], cstore.auditLog(50).map((a) => [a.created_at, a.actor, a.action, a.detail])))}</section>
</main></body></html>`;
  }

  return router;
}
