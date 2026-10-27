import { randomUUID, timingSafeEqual } from "node:crypto";
import express, { type Request, type RequestHandler, type Router } from "express";
import { z } from "zod";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import type { FacilitatorClient, RoutesConfig } from "@x402/core/server";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { log } from "../lib/log.js";
import type { Store } from "../lib/store.js";
import { checkPayment, hasUnverifiableSignature, MAX_INFLIGHT_UNVERIFIED_TOTAL, NETWORKS, paymentKeyOf, USDC } from "../payments/x402.js";
import { hashToken, newToken } from "../services/pipeline.js";
import { formatMicro, toMicro } from "./money.js";
import { priceOf, publicPrice } from "./pricing.js";
import { denominationAllowed, ProviderError, type GiftCardProduct, type GuardedProvider } from "./provider.js";
import type { CommerceStore, OrderRow, QuoteRow } from "./store.js";
import type { Vault } from "./vault.js";

/**
 * Agent Gift Cards: catalog (free) -> quote (free, binding for a few minutes) -> order (x402, exact quoted amount) -> code.
 *
 * Safety rules:
 * - The payment amount comes from the stored quote, never from the request. A payment for any other amount is refused
 *   before settlement (checkPayment), so a manipulated price cannot buy anything.
 * - Upfront settlement: the supplier order is placed only after the payment settled on-chain and the order row says so.
 * - One quote -> at most one order; one payment -> at most one order (UNIQUE constraints, store.ts). A repeated call with
 *   the same payment never buys a second card and never returns the code (the code needs the order token).
 * - The supplier gets the order id as idempotency key, so a retried delivery never buys a second card either.
 * - Paid but not delivered -> status refund_pending (dashboard: retry delivery or record the refund).
 * - Codes are stored only encrypted, never logged, and returned only to the holder of the order token.
 */
export const ORDER_ROUTE = "/api/v1/giftcards/orders";

export interface GiftCardConfig {
  mode: "off" | "mock";
  maxOrderUsd: number;
  dailyLimitUsd: number;
  payerDailyOrders: number;
  quoteTtlSeconds: number;
  paymentFeeUsd: string;
  /** Present when x402 payments are on (testnet). Without it, orders are free mock orders (development only). */
  payments?: { mode: "testnet" | "mainnet"; payTo: string; publicBaseUrl: string; facilitator: FacilitatorClient };
}

type Locals = { quote?: QuoteRow; orderId?: string; orderToken?: string; executed?: boolean; finish?: (executed: boolean) => void };

const QuoteBody = z.object({ product_id: z.string().regex(/^[a-z0-9-]{3,60}$/), face_value: z.string().regex(/^\d{1,6}(\.\d{1,2})?$/) }).strict();
const OrderBody = z.object({ quote_id: z.string().uuid() }).strict();
const ProductQuery = z.object({
  brand: z.string().max(80).optional(),
  country: z.string().regex(/^[A-Za-z]{2}$/).optional(),
  currency: z.string().regex(/^[A-Za-z]{3}$/).optional(),
  category: z.string().max(40).optional(),
});

const sameHash = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const bearer = (req: Request) => {
  const auth = req.get("authorization") ?? "";
  return auth.startsWith("Bearer ") ? auth.slice(7).trim() : undefined;
};
const usd = (micro: number) => formatMicro(BigInt(micro));

export function createGiftCards(deps: { cfg: GiftCardConfig; store: Store; cstore: CommerceStore; provider: GuardedProvider; vault: Vault | null; limiter: RequestHandler }) {
  const { cfg, store, cstore, provider, vault, limiter } = deps;
  const enabled = cfg.mode !== "off" && vault !== null;
  const router = express.Router();

  // Catalog cache: the supplier's catalog changes rarely; prices are always fetched live at quote time.
  let catalog: { at: number; products: GiftCardProduct[] } | null = null;
  async function products(): Promise<GiftCardProduct[]> {
    if (catalog && Date.now() - catalog.at < 5 * 60_000) return catalog.products;
    catalog = { at: Date.now(), products: await provider.products() };
    return catalog.products;
  }

  const unavailable = (res: express.Response) => res.status(503).json({ error: "giftcards_unavailable", message: "Gift card purchases are not available on this server (test module, not switched on). Nothing was charged." });
  const gate: RequestHandler = (_req, res, next) => (enabled ? next() : void unavailable(res));
  const notPaused: RequestHandler = (_req, res, next) => {
    if (!cstore.paused()) return next();
    res.status(503).json({ error: "purchases_paused", message: "New gift card purchases are paused by the operator. Nothing was charged." });
  };
  const providerError = (res: express.Response, err: unknown) => {
    const code = err instanceof ProviderError ? err.code : "provider_unavailable";
    res.status(code === "provider_rejected" ? 422 : 503).json({ error: code, message: "The gift card supplier could not answer. Nothing was charged; try again later." });
  };

  router.get("/api/v1/giftcards/catalog", limiter, gate, async (_req, res) => {
    try {
      const list = await products();
      const uniq = (k: keyof GiftCardProduct) => [...new Set(list.map((p) => String(p[k])))].sort();
      res.json({ provider: provider.id, test_mode: !provider.live, products: list.length, brands: uniq("brand"), countries: uniq("country"), currencies: uniq("currency"), categories: uniq("category"), next: "GET /api/v1/giftcards/products, then POST /api/v1/giftcards/quote" });
    } catch (err) {
      providerError(res, err);
    }
  });

  router.get("/api/v1/giftcards/products", limiter, gate, async (req, res) => {
    const q = ProductQuery.safeParse(req.query);
    if (!q.success) return void res.status(400).json({ error: "invalid_input", issues: q.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
    try {
      const f = q.data;
      const match = (v: string, want?: string) => !want || v.toLowerCase() === want.toLowerCase();
      const list = (await products()).filter((p) => match(p.brand, f.brand) && match(p.country, f.country) && match(p.currency, f.currency) && match(p.category, f.category));
      res.json({ test_mode: !provider.live, products: list });
    } catch (err) {
      providerError(res, err);
    }
  });

  // Free, binding price offer. The live supplier price and availability are checked now; the quote is valid for a few minutes.
  router.post("/api/v1/giftcards/quote", limiter, gate, notPaused, async (req, res) => {
    const body = QuoteBody.safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: "invalid_input", message: "Send {product_id, face_value} (face_value like \"25.00\").", issues: body.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
    if (provider.open()) return void res.status(503).json({ error: "provider_unavailable", message: "The gift card supplier is temporarily unavailable. Nothing was charged." });
    try {
      const product = (await products()).find((p) => p.id === body.data.product_id);
      if (!product) return void res.status(404).json({ error: "unknown_product" });
      if (!denominationAllowed(product, body.data.face_value)) return void res.status(422).json({ error: "invalid_face_value", denominations: product.denominations });
      const sq = await provider.quote(product.id, body.data.face_value);
      if (!sq.available) return void res.status(409).json({ error: "not_available", message: "This card is currently out of stock at the supplier." });
      const price = priceOf({ cost: sq.cost, costCurrency: sq.cost_currency, rateToUsd: sq.rate_to_usd, providerFeeUsd: sq.fee_usd, paymentFeeUsd: cfg.paymentFeeUsd, markupBps: cstore.markupBps() });
      if (price.sale_micro > toMicro(String(cfg.maxOrderUsd))) return void res.status(422).json({ error: "order_too_large", message: `Orders are limited to ${cfg.maxOrderUsd} USDC.` });
      if (cstore.volumeToday() + Number(price.sale_micro) > cfg.dailyLimitUsd * 1_000_000) return void res.status(503).json({ error: "daily_limit_reached", message: "Today's gift card volume is used up. Try again tomorrow (UTC). Nothing was charged." });
      const id = randomUUID();
      const expires = new Date(Date.now() + cfg.quoteTtlSeconds * 1000).toISOString();
      cstore.addQuote({ id, expires_at: expires, product_id: product.id, face_value: body.data.face_value, currency: product.currency, cost_micro: Number(price.cost_micro), markup_micro: Number(price.markup_micro), payment_fee_micro: Number(price.payment_fee_micro), sale_micro: Number(price.sale_micro), markup_bps: price.markup_bps });
      store.bump("giftcards", "quote");
      res.json({
        quote_id: id,
        product_id: product.id,
        brand: product.brand,
        face_value: body.data.face_value,
        currency: product.currency,
        price: publicPrice(price),
        expires_at: expires,
        test_mode: !provider.live,
        next: `POST ${ORDER_ROUTE} with {"quote_id":"${id}"} and an x402 payment of exactly ${formatMicro(price.sale_micro)} USDC before ${expires}.`,
      });
    } catch (err) {
      providerError(res, err);
    }
  });

  // ---------------------------------------------------------------------------------------------
  // Order: prepare -> (claim payment -> x402 settle upfront) -> deliver
  // ---------------------------------------------------------------------------------------------
  const paymentHeader = (req: Request) => req.get("payment-signature") ?? req.get("x-payment");

  const prepareOrder: RequestHandler = (req, res, next) => {
    const body = OrderBody.safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: "invalid_input", message: "Send {quote_id} from POST /api/v1/giftcards/quote. Nothing was charged." });
    const quote = cstore.quote(body.data.quote_id);
    if (!quote) return void res.status(404).json({ error: "unknown_quote", message: "Unknown or deleted quote. Request a new one. Nothing was charged." });
    if (quote.status !== "open") {
      const header = paymentHeader(req);
      let own: OrderRow | undefined;
      if (header) {
        try {
          own = cstore.byPaymentKey(paymentKeyOf(decodePaymentSignatureHeader(header)).key);
        } catch { /* unreadable: treat as a different payment */ }
      }
      // The same payment presented again: it is public on-chain once settled, so it proves nothing. Status only, never the code.
      if (own && own.quote_id === quote.id) return void res.status(409).json({ error: "payment_already_used", order_id: own.id, status: own.status, message: `This payment was already used. Fetch the order with GET ${ORDER_ROUTE}/${own.id} and your order token. Do not pay again.` });
      return void res.status(409).json({ error: "quote_already_used", message: "This quote was already used for an order. Request a new quote. If you paid, keep your order token. Nothing was charged now." });
    }
    if (Date.parse(quote.expires_at) <= Date.now()) return void res.status(410).json({ error: "quote_expired", message: "The quote has expired. Request a new one. Nothing was charged." });
    (res.locals as Locals).quote = quote;
    next();
  };

  const limits = () => ({ dailyMicro: cfg.dailyLimitUsd * 1_000_000, payerDailyOrders: cfg.payerDailyOrders });
  const refusal = (reason: string): { status: number; body: Record<string, unknown> } => {
    switch (reason) {
      case "quote_expired":
        return { status: 410, body: { error: "quote_expired", message: "The quote has expired. Nothing was charged." } };
      case "daily_limit":
        return { status: 503, body: { error: "daily_limit_reached", message: "Today's gift card volume is used up. Nothing was charged." } };
      case "payer_limit":
        return { status: 429, body: { error: "payer_limit", message: "This wallet reached today's number of gift card orders. Nothing was charged." } };
      default:
        return { status: 409, body: { error: "quote_already_used", message: "This quote or payment is already in use. Nothing was charged." } };
    }
  };

  /** Supplier order with the order id as idempotency key. One automatic retry for timeouts / outages, then refund_pending. */
  async function deliver(orderId: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const row = cstore.order(orderId)!;
    let lastError = "provider_unavailable";
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const card = await provider.order({ idempotencyKey: row.id, productId: row.product_id, faceValue: row.face_value });
        let stored = false;
        try {
          stored = cstore.delivered(row.id, card.provider_order_id, vault!.seal(JSON.stringify({ code: card.code, pin: card.pin, expires_at: card.expires_at }), row.id));
        } catch { /* handled below */ }
        // Never hand out a code we could not store: a retry with the same idempotency key returns the same card later.
        if (!stored) {
          lastError = "store_failed";
          break;
        }
        store.bump("giftcards", "delivered");
        return { status: 200, body: { status: "delivered", gift_card: { code: card.code, pin: card.pin, expires_at: card.expires_at } } };
      } catch (err) {
        lastError = err instanceof ProviderError ? err.code : "provider_unavailable";
        if (lastError === "provider_rejected" || lastError === "provider_invalid_response") break;
      }
    }
    cstore.deliveryFailed(row.id, lastError);
    store.bump("giftcards", "delivery_failed");
    log.warn("gift card paid but not delivered", { order_id: row.id, reason: lastError });
    return { status: 502, body: { status: "refund_pending", error: lastError, message: "Your payment was received, but the supplier did not deliver. We retry the delivery or refund the payment. Keep your order token and do not pay again." } };
  }

  const orderView = (row: OrderRow) => ({
    order_id: row.id,
    status: row.status,
    product_id: row.product_id,
    face_value: row.face_value,
    currency: row.currency,
    price_usdc: usd(row.sale_micro),
    network: row.network,
    tx_hash: row.tx_hash,
    refund_tx: row.refund_tx,
    test_mode: row.data_source !== "live",
    created_at: row.created_at,
  });

  const deliverStep: RequestHandler = async (_req, res) => {
    const locals = res.locals as Locals;
    locals.executed = true;
    const row = cstore.order(locals.orderId!);
    // Upfront flow: by now the facilitator settled and onAfterSettle recorded it. If not, never order a card.
    if (!row || row.status !== "paid") {
      if (row?.status === "payment_pending") cstore.uncertain(row.id);
      log.error("gift card order reached delivery without a recorded settlement", { order_id: locals.orderId });
      return void res.status(502).json({ error: "payment_unconfirmed", order_id: locals.orderId, order_token: locals.orderToken, message: "The payment outcome is not confirmed, so no card was ordered. Do not pay again; contact support with this order id." });
    }
    const out = await deliver(row.id);
    res.status(out.status).json({ ...orderView(cstore.order(row.id)!), order_token: locals.orderToken, ...out.body, notice: "Store the code and the order token now. The code can be fetched again with the token for 30 days, then it is deleted." });
  };

  // Development without payments: free mock orders (the env check forbids this with real money).
  const sandboxClaim: RequestHandler = (_req, res, next) => {
    const locals = res.locals as Locals;
    const id = randomUUID();
    const token = newToken();
    const claim = cstore.claimOrder({ id, quote_id: locals.quote!.id, data_source: provider.live ? "live" : "mock", network: null, payer: null, payment_key: null, payment_nonce: null, token_hash: hashToken(token) }, limits());
    if (!claim.ok) {
      const r = refusal(claim.reason);
      return void res.status(r.status).json(r.body);
    }
    locals.orderId = id;
    locals.orderToken = token;
    next();
  };

  const chain: RequestHandler[] = [limiter, gate, notPaused, prepareOrder];
  if (cfg.payments) chain.push(...orderPayments(cfg.payments));
  else chain.push(sandboxClaim);
  router.post(ORDER_ROUTE, ...chain, deliverStep);

  router.get(`${ORDER_ROUTE}/:id`, limiter, (req, res) => {
    const token = bearer(req);
    const row = /^[0-9a-f-]{36}$/.test(String(req.params.id)) ? cstore.order(String(req.params.id)) : undefined;
    // Unknown id and wrong token look the same: order ids cannot be probed.
    if (!row || !token || !sameHash(hashToken(token), row.token_hash)) return void res.status(404).json({ error: "not_found", message: "Unknown order or wrong order token." });
    const view: Record<string, unknown> = orderView(row);
    if (row.status === "delivered") {
      view.gift_card = row.code_sealed && vault ? JSON.parse(vault.open(row.code_sealed, row.id)) : null;
      if (!row.code_sealed) view.notice = "The code was deleted after the retention period.";
    } else if (row.status === "refund_pending") {
      view.notice = "Paid but not delivered yet. We retry the delivery or refund the payment. Do not pay again.";
    } else if (row.status === "settlement_uncertain") {
      view.notice = "The payment outcome is being checked. No card was ordered. Do not pay again.";
    }
    res.json(view);
  });

  router.all(ORDER_ROUTE, (_req, res) => {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "method_not_allowed", message: "Use POST." });
  });

  // ---------------------------------------------------------------------------------------------
  // x402 for orders: its own resource server, so the data API's payment ledger stays untouched.
  // ---------------------------------------------------------------------------------------------
  function orderPayments(p: NonNullable<GiftCardConfig["payments"]>): RequestHandler[] {
    const network = NETWORKS[p.mode];
    const usdc = USDC[p.mode];
    const server = new x402ResourceServer(p.facilitator)
      .register(network, new ExactEvmScheme())
      .onBeforeSettle(async ({ paymentPayload }) => {
        try {
          if (cstore.startSettlement(paymentKeyOf(paymentPayload as PaymentPayload).key)) return;
        } catch { /* abort below: the SDK swallows thrown hook errors */ }
        return { abort: true, reason: "order_ledger_unavailable" };
      })
      .onAfterSettle(async ({ paymentPayload, result }) => {
        const row = cstore.byPaymentKey(paymentKeyOf(paymentPayload as PaymentPayload).key);
        if (row && result.success && result.transaction) {
          cstore.setSettled(row.id, result.transaction, result.payer?.toLowerCase() ?? null);
          store.bump("giftcards", "settled");
          log.info("gift card payment settled", { order_id: row.id, tx: result.transaction, network: result.network });
        } else if (!row && result.success) {
          log.error("settled gift card payment without order row", { tx: result.transaction, network: result.network });
        }
      })
      .onSettleFailure(async ({ paymentPayload }) => {
        let orderId: string | undefined;
        try {
          orderId = cstore.byPaymentKey(paymentKeyOf(paymentPayload as PaymentPayload).key)?.id;
        } catch { /* unreadable */ }
        store.bump("giftcards", "settle_failed");
        log.warn("gift card settlement failed", { order_id: orderId, reason: "settlement_not_confirmed" });
      });

    // The price is the stored quote's amount, as exact USDC atomic units (USDC has 6 decimals = our micro-units).
    const routes: RoutesConfig = {
      [`POST ${ORDER_ROUTE}`]: {
        accepts: [{
          scheme: "exact",
          network,
          payTo: p.payTo,
          price: (ctx) => {
            const id = (ctx.adapter.getBody?.() as { quote_id?: unknown } | undefined)?.quote_id;
            const quote = typeof id === "string" ? cstore.quote(id) : undefined;
            if (!quote) throw new Error("quote not found");
            return { amount: String(quote.sale_micro), asset: usdc.asset, extra: { name: usdc.name, version: usdc.version } };
          },
          maxTimeoutSeconds: 120,
          extra: { paymentFlow: "upfront" },
        }],
        resource: `${p.publicBaseUrl}${ORDER_ROUTE}`,
        description: "Buy the gift card of a quote (exact quoted amount).",
        mimeType: "application/json",
        serviceName: "Agent Gift Cards",
      },
    };
    const middleware = paymentMiddleware(routes, server);
    const inflightPayers = new Set<string>();
    // Smart-wallet signatures cannot be checked offline (see x402.ts): only a few may be at the facilitator at once.
    let unverifiedInflight = 0;

    const claim: RequestHandler = async (req, res, next) => {
      const header = paymentHeader(req);
      if (!header) {
        store.bump("giftcards", "payment_required");
        return next(); // the x402 middleware answers 402 with the quoted price
      }
      const locals = res.locals as Locals;
      const quote = locals.quote!;
      let payload: PaymentPayload;
      try {
        payload = decodePaymentSignatureHeader(header);
      } catch {
        return next();
      }
      const bad = await checkPayment(payload, { mode: p.mode, amount: String(quote.sale_micro), payTo: p.payTo });
      if (bad) {
        store.bump("giftcards", "invalid_payment");
        return void res.status(400).json({ error: "invalid_payment", message: `${bad}. Nothing was charged.` });
      }
      const { key, payer } = paymentKeyOf(payload);
      if (!payer) return void res.status(400).json({ error: "invalid_payment", message: "payment has no payer. Nothing was charged." });
      if (inflightPayers.has(payer)) return void res.status(429).set("Retry-After", "10").json({ error: "payer_busy", message: "This wallet has a gift card order in progress. Nothing was charged." });
      const unverified = hasUnverifiableSignature(payload);
      if (unverified && unverifiedInflight >= Math.min(2, MAX_INFLIGHT_UNVERIFIED_TOTAL)) return void res.status(429).set("Retry-After", "5").json({ error: "busy", message: "Too many payments are being checked right now. Retry shortly. Nothing was charged." });
      const id = randomUUID();
      const token = newToken();
      const nonce = (payload.payload as { authorization?: { nonce?: string } }).authorization?.nonce?.toLowerCase() ?? null;
      const result = cstore.claimOrder({ id, quote_id: quote.id, data_source: provider.live ? "live" : "mock", network, payer, payment_key: key, payment_nonce: nonce, token_hash: hashToken(token) }, limits());
      if (!result.ok) {
        if (result.reason === "payer_limit") {
          store.bump("giftcards", "suspicious_payer_limit");
          log.warn("gift card payer limit reached", { payer });
        }
        const r = refusal(result.reason);
        return void res.status(r.status).json(r.body);
      }
      inflightPayers.add(payer);
      if (unverified) unverifiedInflight++;
      res.setHeader("X-Order-Id", id);
      locals.orderId = id;
      locals.orderToken = token;
      let done = false;
      locals.finish = (executed) => {
        if (done) return;
        done = true;
        inflightPayers.delete(payer);
        if (unverified) unverifiedInflight--;
        if (executed) return;
        const row = cstore.order(id);
        if (row?.status !== "payment_pending") return;
        // Settlement attempted but not confirmed: keep the row for a manual check. Never attempted: nothing charged, drop it.
        if (row.settlement_started) cstore.uncertain(id);
        else cstore.release(id);
      };
      next();
    };

    const x402: RequestHandler = async (req, res, next) => {
      const locals = res.locals as Locals;
      try {
        await (middleware(req, res, next) as unknown as Promise<unknown>);
      } finally {
        locals.finish?.(Boolean(locals.executed));
      }
    };
    return [claim, x402];
  }

  /** Admin: try the delivery of a paid, undelivered order again. Same idempotency key, so never a second card. */
  async function redeliver(orderId: string, actor: string): Promise<boolean> {
    if (!enabled || !cstore.beginRedelivery(orderId)) return false;
    cstore.audit(actor, "retry_delivery", orderId);
    const out = await deliver(orderId);
    return out.status === 200;
  }

  return { router, enabled, redeliver, info: () => ({ enabled, paused: cstore.paused(), test_mode: !provider.live, provider: provider.id, markup_percent: Number(cstore.markupBps()) / 100, max_order_usdc: cfg.maxOrderUsd, quote_ttl_seconds: cfg.quoteTtlSeconds }) };
}

export type GiftCards = ReturnType<typeof createGiftCards>;
