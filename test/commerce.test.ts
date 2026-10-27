import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { x402Client } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { buildTestApp, fakeFetch, PAY_TO } from "./helpers.js";
import { fakeFacilitator, post, start } from "./x402helpers.js";
import { loadEnv } from "../src/config/env.js";
import { ceilToCent, convertToUsd, formatMicro, toMicro, toRate } from "../src/commerce/money.js";
import { priceOf } from "../src/commerce/pricing.js";
import { guardProvider, MockGiftCardProvider, ProviderError, type GiftCardProvider } from "../src/commerce/provider.js";
import { createVault } from "../src/commerce/vault.js";
import type { Commerce } from "../src/commerce/index.js";
import { setLogLevel } from "../src/lib/log.js";

const KEY = "11".repeat(32);
const MOCK = { GIFTCARDS_MODE: "mock", GIFTCARDS_ENCRYPTION_KEY: KEY };
const TESTNET = { ...MOCK, PAYMENT_MODE: "testnet", PAY_TO_ADDRESS: PAY_TO, DATAFORSEO_LOGIN: "l", DATAFORSEO_PASSWORD: "p" };
const ORIGIN = "http://localhost:3000";
const basic = (u: string, p: string) => `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}`;
const noUpstream = () => fakeFetch({}).impl;
const commerceOf = (app: { locals: Record<string, unknown> }) => app.locals.commerce as Commerce;

/** Buyer with a raised spend cap: x402 clients refuse payments above 1 USD by default. */
function signer() {
  const client = new x402Client().setSpendControls({ maxAmountPerPayment: "$150" });
  registerExactEvmScheme(client, { signer: privateKeyToAccount(generatePrivateKey()) });
  return client;
}

describe("price engine (exact decimals)", () => {
  const base = { costCurrency: "USD", rateToUsd: "1", providerFeeUsd: "0", paymentFeeUsd: "0", markupBps: 350 };

  it("100.00 USD cost + 3.5 % = 103.50, contribution 3.50", () => {
    const p = priceOf({ ...base, cost: "100.00" });
    expect(formatMicro(p.sale_micro)).toBe("103.50");
    expect(formatMicro(p.markup_micro)).toBe("3.50");
    expect(formatMicro(p.contribution_micro)).toBe("3.50");
  });

  it("rounds up to whole cents, never down", () => {
    // 10.01 * 1.035 = 10.36035 -> 10.37
    expect(formatMicro(priceOf({ ...base, cost: "10.01" }).sale_micro)).toBe("10.37");
    // values where float math drifts: 0.1 + 0.2 style
    expect(formatMicro(priceOf({ ...base, cost: "0.30", markupBps: 0 }).sale_micro)).toBe("0.30");
    expect(ceilToCent(1n)).toBe(10_000n);
  });

  it("adds provider fee and payment fee before rounding; contribution excludes the payment fee", () => {
    const p = priceOf({ ...base, cost: "50.00", providerFeeUsd: "0.50", paymentFeeUsd: "0.001" });
    // cost 50.50, markup 1.7675, + 0.001 = 52.2685 -> 52.27
    expect(formatMicro(p.cost_micro, 6)).toBe("50.500000");
    expect(formatMicro(p.sale_micro)).toBe("52.27");
    expect(formatMicro(p.contribution_micro, 6)).toBe("1.769000");
  });

  it("refuses out-of-range markups and malformed amounts", () => {
    expect(() => priceOf({ ...base, cost: "10", markupBps: -1 })).toThrow();
    expect(() => priceOf({ ...base, cost: "10", markupBps: 2001 })).toThrow();
    expect(() => priceOf({ ...base, cost: "1e3" })).toThrow();
    expect(() => priceOf({ ...base, cost: "-5" })).toThrow();
    expect(() => priceOf({ ...base, cost: "0" })).toThrow();
    expect(() => toMicro("1.0000001")).toThrow();
  });
});

describe("currency conversion", () => {
  it("converts EUR to USD exactly and rounds the cost up", () => {
    expect(convertToUsd(toMicro("25.00"), toRate("1.08"))).toBe(27_000_000n);
    expect(convertToUsd(toMicro("0.000001"), toRate("1.5"))).toBe(2n); // 1.5 micro -> 2 micro
    const p = priceOf({ cost: "25.00", costCurrency: "EUR", rateToUsd: "1.08", providerFeeUsd: "0", paymentFeeUsd: "0", markupBps: 350 });
    expect(formatMicro(p.sale_micro)).toBe("27.95"); // 27.945 -> 27.95
  });
  it("rejects a USD cost with a rate other than 1 and a zero rate", () => {
    expect(() => priceOf({ cost: "10", costCurrency: "USD", rateToUsd: "1.1", providerFeeUsd: "0", paymentFeeUsd: "0", markupBps: 350 })).toThrow();
    expect(() => priceOf({ cost: "10", costCurrency: "EUR", rateToUsd: "0", providerFeeUsd: "0", paymentFeeUsd: "0", markupBps: 350 })).toThrow();
  });
});

describe("code vault", () => {
  it("encrypts codes and binds them to the order id", () => {
    const v = createVault(KEY);
    const sealed = v.seal("DEMO-CODE", "order-1");
    expect(sealed).not.toContain("DEMO");
    expect(v.open(sealed, "order-1")).toBe("DEMO-CODE");
    expect(() => v.open(sealed, "order-2")).toThrow();
    const [a, b, c, d] = sealed.split(":");
    expect(() => v.open([a, b, c, `A${d!.slice(1)}`].join(":"), "order-1")).toThrow();
    expect(() => createVault("short")).toThrow();
  });
});

describe("supplier guard", () => {
  it("rejects malformed supplier responses", async () => {
    const bad = { ...new MockGiftCardProvider(), id: "bad", live: false, products: async () => [{ id: "<script>" }], quote: async () => ({ cost: "NaN" }), order: async () => ({ code: "" }) } as unknown as GiftCardProvider;
    const g = guardProvider(bad);
    await expect(g.products()).rejects.toMatchObject({ code: "provider_invalid_response" });
    await expect(g.quote("x", "10")).rejects.toMatchObject({ code: "provider_invalid_response" });
  });

  it("opens the circuit after repeated failures and times out slow calls", async () => {
    let t = 0;
    const slow = { id: "slow", live: false, products: (s: AbortSignal) => new Promise((_r, rej) => s.addEventListener("abort", () => rej(new Error("aborted")))), quote: async () => { throw new Error("down"); }, order: async () => { throw new Error("down"); } } as unknown as GiftCardProvider;
    const g = guardProvider(slow, { timeoutMs: 20, now: () => t });
    await expect(g.products()).rejects.toMatchObject({ code: "provider_timeout" });
    await expect(g.quote("a", "1")).rejects.toBeInstanceOf(ProviderError);
    await expect(g.quote("a", "1")).rejects.toBeInstanceOf(ProviderError);
    expect(g.open()).toBe(true);
    t += 6 * 60_000;
    expect(g.open()).toBe(false);
  });
});

describe("environment rules", () => {
  it("never allows the mock supplier with real money and requires the encryption key", () => {
    expect(() => loadEnv({ NODE_ENV: "test", ...MOCK, PAYMENT_MODE: "mainnet" })).toThrow(/GIFTCARDS_MODE/);
    expect(() => loadEnv({ NODE_ENV: "test", GIFTCARDS_MODE: "mock" })).toThrow(/GIFTCARDS_ENCRYPTION_KEY/);
    expect(loadEnv({ NODE_ENV: "test" }).GIFTCARDS_MODE).toBe("off");
    expect(() => loadEnv({ NODE_ENV: "test", GIFTCARDS_PAYMENT_FEE_USD: "05" })).toThrow(/GIFTCARDS_PAYMENT_FEE_USD/);
  });
});

describe("gift card API: switched off by default", () => {
  it("answers 503 and charges nothing; the data API is unchanged", async () => {
    const { app } = buildTestApp({ fetchImpl: noUpstream() });
    for (const [m, path] of [["get", "/api/v1/giftcards/catalog"], ["get", "/api/v1/giftcards/products"], ["post", "/api/v1/giftcards/quote"], ["post", "/api/v1/giftcards/orders"]] as const) {
      const r = await request(app)[m](path).send({});
      expect(r.status).toBe(503);
      expect(r.body.error).toBe("giftcards_unavailable");
    }
    const overview = await request(app).get("/api/v1/commerce");
    expect(overview.body.giftcards.enabled).toBe(false);
    expect((await request(app).get("/api/v1/services")).status).toBe(200);
  });
});

describe("gift card API with the mock supplier (no payments, development)", () => {
  const setup = () => buildTestApp({ fetchImpl: noUpstream(), env: MOCK });

  it("catalog, filters, quote, order, fetch with token", async () => {
    const { app } = setup();
    const cat = await request(app).get("/api/v1/giftcards/catalog");
    expect(cat.status).toBe(200);
    expect(cat.body.test_mode).toBe(true);
    expect(cat.body.countries).toContain("DE");
    const de = await request(app).get("/api/v1/giftcards/products?country=de&category=books");
    expect(de.body.products.map((p: { id: string }) => p.id)).toEqual(["demo-books-de"]);
    expect((await request(app).get("/api/v1/giftcards/products?country=Germany")).status).toBe(400);

    const q = await request(app).post("/api/v1/giftcards/quote").send({ product_id: "demo-books-de", face_value: "25.00" });
    expect(q.status).toBe(200);
    expect(q.body.price).toMatchObject({ amount_usdc: "27.95", service_fee_percent: "3.5" });
    expect(q.body).not.toHaveProperty("cost");

    const o = await request(app).post("/api/v1/giftcards/orders").send({ quote_id: q.body.quote_id });
    expect(o.status).toBe(200);
    expect(o.body.status).toBe("delivered");
    expect(o.body.gift_card.code).toMatch(/^DEMO-/);
    expect(o.body.price_usdc).toBe("27.95");

    const again = await request(app).get(`/api/v1/giftcards/orders/${o.body.order_id}`).set("authorization", `Bearer ${o.body.order_token}`);
    expect(again.body.gift_card.code).toBe(o.body.gift_card.code);
    const wrong = await request(app).get(`/api/v1/giftcards/orders/${o.body.order_id}`).set("authorization", "Bearer nope");
    expect(wrong.status).toBe(404);
    expect(JSON.stringify(wrong.body)).not.toContain("DEMO-");
    expect((await request(app).get(`/api/v1/giftcards/orders/${o.body.order_id}`)).status).toBe(404);

    // A quote buys at most one card.
    const twice = await request(app).post("/api/v1/giftcards/orders").send({ quote_id: q.body.quote_id });
    expect(twice.status).toBe(409);
    expect(twice.body.error).toBe("quote_already_used");
  });

  it("validates input, denominations, limits and expiry before anything is bought", async () => {
    const { app } = setup();
    expect((await request(app).post("/api/v1/giftcards/quote").send({ product_id: "demo-books-de", face_value: "26.00" })).body.error).toBe("invalid_face_value");
    expect((await request(app).post("/api/v1/giftcards/quote").send({ product_id: "nope-xyz", face_value: "10.00" })).status).toBe(404);
    expect((await request(app).post("/api/v1/giftcards/quote").send({ product_id: "demo-books-de", face_value: "25", price: "0.01" })).status).toBe(400);
    expect((await request(app).post("/api/v1/giftcards/quote").send({ product_id: "demo-games-us", face_value: "100.00" })).body.error).toBe("order_too_large");
    expect((await request(app).post("/api/v1/giftcards/orders").send({ quote_id: "00000000-0000-4000-8000-000000000000" })).status).toBe(404);

    const q = await request(app).post("/api/v1/giftcards/quote").send({ product_id: "demo-games-us", face_value: "10.00" });
    commerceOf(app).cstore.db.prepare(`UPDATE gc_quotes SET expires_at=? WHERE id=?`).run(new Date(Date.now() - 1000).toISOString(), q.body.quote_id);
    expect((await request(app).post("/api/v1/giftcards/orders").send({ quote_id: q.body.quote_id })).status).toBe(410);
  });

  it("kill switch and markup setting apply to new quotes", async () => {
    const { app } = setup();
    const { cstore } = commerceOf(app);
    cstore.setSetting("markup_bps", "500", "test");
    const q = await request(app).post("/api/v1/giftcards/quote").send({ product_id: "demo-games-us", face_value: "20.00" });
    expect(q.body.price.amount_usdc).toBe("21.00");
    cstore.setSetting("paused", "1", "test");
    expect((await request(app).post("/api/v1/giftcards/quote").send({ product_id: "demo-games-us", face_value: "20.00" })).body.error).toBe("purchases_paused");
    expect((await request(app).post("/api/v1/giftcards/orders").send({ quote_id: q.body.quote_id })).body.error).toBe("purchases_paused");
  });
});

describe("gift card orders with x402 (testnet, mock supplier)", () => {
  function setup(opts: { failSettle?: boolean } = {}) {
    const events: string[] = [];
    const facilitator = fakeFacilitator(events, opts);
    const provider = new MockGiftCardProvider();
    const orig = provider.order.bind(provider);
    provider.order = async (req) => {
      events.push("supplier_order");
      return orig(req);
    };
    const built = buildTestApp({ fetchImpl: noUpstream(), env: TESTNET, facilitator, giftcardProvider: provider });
    return { ...built, events, facilitator, provider };
  }

  async function quote(base: string, product = "demo-games-us", face = "20.00") {
    const r = await fetch(`${base}/api/v1/giftcards/quote`, post({ product_id: product, face_value: face }));
    return (await r.json()) as { quote_id: string; price: { amount_usdc: string } };
  }

  /** Get the 402 offer for a quote and sign a payment for it (optionally tampered). */
  async function signedHeader(base: string, quoteId: string, client = signer(), tamper?: (req: Record<string, unknown>) => void) {
    const offer = await fetch(`${base}/api/v1/giftcards/orders`, post({ quote_id: quoteId }));
    expect(offer.status).toBe(402);
    const required = decodePaymentRequiredHeader(offer.headers.get("payment-required")!);
    if (tamper) tamper(required.accepts[0] as unknown as Record<string, unknown>);
    return { header: encodePaymentSignatureHeader(await client.createPaymentPayload(required)), required };
  }

  it("402 carries the exact quoted amount; the card is ordered only after settlement", async () => {
    const { app, events, provider } = setup();
    const base = await start(app);
    const q = await quote(base);
    expect(q.price.amount_usdc).toBe("20.70");
    const { header, required } = await signedHeader(base, q.quote_id);
    expect(required.accepts[0]!.amount).toBe("20700000");
    expect(required.accepts[0]!.payTo.toLowerCase()).toBe(PAY_TO);
    expect(events).toEqual([]); // the offer itself does nothing

    const paid = await fetch(`${base}/api/v1/giftcards/orders`, post({ quote_id: q.quote_id }, { "PAYMENT-SIGNATURE": header }));
    const body = (await paid.json()) as Record<string, any>;
    expect(paid.status).toBe(200);
    expect(body.status).toBe("delivered");
    expect(body.tx_hash).toMatch(/^0x/);
    expect(paid.headers.get("payment-response")).toBeTruthy();
    expect(events).toEqual(["settle", "supplier_order"]);
    expect(provider.orders.size).toBe(1);
    const row = commerceOf(app).cstore.order(body.order_id)!;
    expect(row.code_sealed).not.toContain(body.gift_card.code);
    expect(row.payer).toMatch(/^0x/);
  });

  it("a repeated call with the same payment never buys again and never returns the code", async () => {
    const { app, events, facilitator } = setup();
    const base = await start(app);
    const q = await quote(base);
    const { header } = await signedHeader(base, q.quote_id);
    const first = await fetch(`${base}/api/v1/giftcards/orders`, post({ quote_id: q.quote_id }, { "PAYMENT-SIGNATURE": header }));
    expect(first.status).toBe(200);
    const again = await fetch(`${base}/api/v1/giftcards/orders`, post({ quote_id: q.quote_id }, { "PAYMENT-SIGNATURE": header }));
    const body = await again.text();
    expect(again.status).toBe(409);
    expect(body).toContain("payment_already_used");
    expect(body).not.toContain("DEMO-");
    expect(facilitator.settles()).toBe(1);
    expect(events.filter((e) => e === "supplier_order")).toHaveLength(1);
  });

  it("the same payment cannot be used for a second quote", async () => {
    const { app, facilitator } = setup();
    const base = await start(app);
    const q1 = await quote(base);
    const q2 = await quote(base);
    const { header } = await signedHeader(base, q1.quote_id);
    expect((await fetch(`${base}/api/v1/giftcards/orders`, post({ quote_id: q1.quote_id }, { "PAYMENT-SIGNATURE": header }))).status).toBe(200);
    const reuse = await fetch(`${base}/api/v1/giftcards/orders`, post({ quote_id: q2.quote_id }, { "PAYMENT-SIGNATURE": header }));
    expect(reuse.status).toBe(409);
    expect(facilitator.settles()).toBe(1);
  });

  it("refuses manipulated payment amounts and recipients before settlement", async () => {
    const { app, events } = setup();
    const base = await start(app);
    const q = await quote(base);
    const cheap = await signedHeader(base, q.quote_id, signer(), (r) => { r.amount = "10000"; });
    const r1 = await fetch(`${base}/api/v1/giftcards/orders`, post({ quote_id: q.quote_id }, { "PAYMENT-SIGNATURE": cheap.header }));
    expect(r1.status).toBe(400);
    expect(((await r1.json()) as { error: string }).error).toBe("invalid_payment");
    const elsewhere = await signedHeader(base, q.quote_id, signer(), (r) => { r.payTo = "0x000000000000000000000000000000000000dEaD"; });
    expect((await fetch(`${base}/api/v1/giftcards/orders`, post({ quote_id: q.quote_id }, { "PAYMENT-SIGNATURE": elsewhere.header }))).status).toBe(400);
    expect(events).toEqual([]);
    // The quote is still usable for an honest payment.
    const honest = await signedHeader(base, q.quote_id);
    expect((await fetch(`${base}/api/v1/giftcards/orders`, post({ quote_id: q.quote_id }, { "PAYMENT-SIGNATURE": honest.header }))).status).toBe(200);
  });

  it("a failed settlement orders nothing and keeps the order for a manual check", async () => {
    const { app, events } = setup({ failSettle: true });
    const base = await start(app);
    const q = await quote(base);
    const { header } = await signedHeader(base, q.quote_id);
    const r = await fetch(`${base}/api/v1/giftcards/orders`, post({ quote_id: q.quote_id }, { "PAYMENT-SIGNATURE": header }));
    expect(r.status).toBe(402);
    expect(events).toEqual(["settle"]);
    const row = commerceOf(app).cstore.orderForQuote(q.quote_id)!;
    expect(row.status).toBe("settlement_uncertain");
    expect(row.code_sealed).toBeNull();
    // A rejected payment does not use up the daily limit for other buyers.
    expect(commerceOf(app).cstore.volumeToday()).toBe(0);
  });

  it("supplier failure after payment -> refund_pending; admin retry delivers exactly one card", async () => {
    const { app, events, provider } = setup();
    provider.failOrders = 2;
    const base = await start(app);
    const q = await quote(base);
    const { header } = await signedHeader(base, q.quote_id);
    const r = await fetch(`${base}/api/v1/giftcards/orders`, post({ quote_id: q.quote_id }, { "PAYMENT-SIGNATURE": header }));
    const body = (await r.json()) as Record<string, any>;
    expect(r.status).toBe(502);
    expect(body.status).toBe("refund_pending");
    expect(body.order_token).toBeTruthy();
    expect(events).toEqual(["settle", "supplier_order", "supplier_order"]);

    const status = await fetch(`${base}/api/v1/giftcards/orders/${body.order_id}`, { headers: { authorization: `Bearer ${body.order_token}` } });
    expect(((await status.json()) as { status: string }).status).toBe("refund_pending");

    expect(await commerceOf(app).giftcards.redeliver(body.order_id, "test")).toBe(true);
    expect(await commerceOf(app).giftcards.redeliver(body.order_id, "test")).toBe(false);
    expect(provider.orders.size).toBe(1);
    const done = await fetch(`${base}/api/v1/giftcards/orders/${body.order_id}`, { headers: { authorization: `Bearer ${body.order_token}` } });
    expect(((await done.json()) as { gift_card: { code: string } }).gift_card.code).toMatch(/^DEMO-/);
  });

  it("limits orders per wallet and day", async () => {
    const { app } = setup();
    const base = await start(app);
    const client = signer();
    for (let i = 0; i < 5; i++) {
      const q = await quote(base, "demo-games-us", "10.00");
      const { header } = await signedHeader(base, q.quote_id, client);
      expect((await fetch(`${base}/api/v1/giftcards/orders`, post({ quote_id: q.quote_id }, { "PAYMENT-SIGNATURE": header }))).status).toBe(200);
    }
    const q = await quote(base, "demo-games-us", "10.00");
    const { header } = await signedHeader(base, q.quote_id, client);
    const r = await fetch(`${base}/api/v1/giftcards/orders`, post({ quote_id: q.quote_id }, { "PAYMENT-SIGNATURE": header }));
    expect(r.status).toBe(429);
  });

  it("gift card codes never reach the logs", async () => {
    setLogLevel("debug");
    const lines: string[] = [];
    const out = vi.spyOn(process.stdout, "write").mockImplementation((c) => (lines.push(String(c)), true));
    const err = vi.spyOn(process.stderr, "write").mockImplementation((c) => (lines.push(String(c)), true));
    try {
      const { app, provider } = setup();
      provider.failOrders = 2;
      const base = await start(app);
      for (let i = 0; i < 2; i++) {
        const q = await quote(base);
        const { header } = await signedHeader(base, q.quote_id);
        await fetch(`${base}/api/v1/giftcards/orders`, post({ quote_id: q.quote_id }, { "PAYMENT-SIGNATURE": header }));
      }
    } finally {
      out.mockRestore();
      err.mockRestore();
      setLogLevel("error");
    }
    expect(lines.join("")).toContain("gift card payment settled");
    expect(lines.join("")).not.toMatch(/DEMO-[0-9A-F]{6}/);
  });

  it("the data API still works next to the commerce module", async () => {
    const { app } = setup();
    const r = await request(app).post("/api/v1/keyword-metrics").send({ keywords: ["seo"], location_code: 2276, language_code: "de" });
    expect(r.status).toBe(402);
  });
});

describe("finance directory", () => {
  it("lists services for information only, without fees or claimed partnerships", async () => {
    const { app } = buildTestApp({ fetchImpl: noUpstream() });
    const p = await request(app).get("/api/v1/finance/partners");
    expect(p.status).toBe(200);
    expect(p.body.disclaimer).toMatch(/no partnership/);
    expect(p.body.partners.every((e: { relationship: string }) => e.relationship === "none")).toBe(true);
    const us = await request(app).get("/api/v1/finance/offers?region=us");
    expect(us.body.offers.length).toBeGreaterThan(0);
    const de = await request(app).get("/api/v1/finance/offers?region=DE");
    expect(de.body.offers).toEqual([]);
    expect((await request(app).get("/api/v1/finance/offers?fee=1")).status).toBe(400);
    expect((await request(app).post("/api/v1/finance/referrals").send({})).status).toBe(404);
  });
});

describe("admin commerce area", () => {
  const env = { ...MOCK, ADMIN_PASSWORD: "owner-password-1234", ADMIN_VIEWER_PASSWORD: "viewer-password-1234" };
  const owner = basic("admin", env.ADMIN_PASSWORD);
  const viewer = basic("viewer", env.ADMIN_VIEWER_PASSWORD);
  const tokenOf = (html: string) => /name="token" value="([0-9a-f]{64})"/.exec(html)?.[1] ?? "";

  it("viewer may look but not change; owner changes need our origin and the form token; changes are audited", async () => {
    const { app } = buildTestApp({ fetchImpl: noUpstream(), env });
    const q = await request(app).post("/api/v1/giftcards/quote").send({ product_id: "demo-games-us", face_value: "10.00" });
    const o = await request(app).post("/api/v1/giftcards/orders").send({ quote_id: q.body.quote_id });

    const seen = await request(app).get("/admin/commerce").set("authorization", viewer);
    expect(seen.status).toBe(200);
    expect(seen.text).toContain("Agent Gift Cards");
    expect(seen.text).not.toContain('name="token"');
    expect(seen.text).not.toContain(o.body.gift_card.code);
    expect((await request(app).post("/admin/commerce/settings").set("authorization", viewer).set("origin", ORIGIN).type("form").send({ markup_percent: "9" })).status).toBe(403);

    const page = await request(app).get("/admin/commerce").set("authorization", owner);
    expect(page.headers["content-security-policy"]).toContain("form-action 'self'");
    const token = tokenOf(page.text);
    expect(token).toHaveLength(64);
    expect((await request(app).post("/admin/commerce/settings").set("authorization", owner).type("form").send({ token, markup_percent: "4" })).status).toBe(403);
    expect((await request(app).post("/admin/commerce/settings").set("authorization", owner).set("origin", "https://evil.example").type("form").send({ token, markup_percent: "4" })).status).toBe(403);
    expect((await request(app).post("/admin/commerce/settings").set("authorization", owner).set("origin", ORIGIN).type("form").send({ token: "x", markup_percent: "4" })).status).toBe(403);

    const ok = await request(app).post("/admin/commerce/settings").set("authorization", owner).set("origin", ORIGIN).type("form").send({ token, markup_percent: "4,25", paused: "1" });
    expect(ok.status).toBe(303);
    const { cstore } = commerceOf(app);
    expect(cstore.markupBps()).toBe(425);
    expect(cstore.paused()).toBe(true);
    expect(cstore.auditLog().map((a) => a.action)).toEqual(expect.arrayContaining(["set_markup_bps", "set_paused"]));

    const tooHigh = await request(app).post("/admin/commerce/settings").set("authorization", owner).set("origin", ORIGIN).type("form").send({ token, markup_percent: "25" });
    expect(tooHigh.headers.location).toMatch(/not%20changed/);
    expect(cstore.markupBps()).toBe(425);

    expect((await request(app).get("/admin/commerce")).status).toBe(401);
  });
});

describe("commerce ledger housekeeping", () => {
  it("restart recovery flags interrupted orders and never drops a settlement attempt; retention deletes codes", async () => {
    const { app } = buildTestApp({ fetchImpl: noUpstream(), env: MOCK });
    const { cstore } = commerceOf(app);
    const q = await request(app).post("/api/v1/giftcards/quote").send({ product_id: "demo-games-us", face_value: "10.00" });
    const o = await request(app).post("/api/v1/giftcards/orders").send({ quote_id: q.body.quote_id });
    expect(cstore.order(o.body.order_id)!.code_sealed).toBeTruthy();

    const mk = async (id: string, settlementStarted: boolean, status: string) => {
      const qq = await request(app).post("/api/v1/giftcards/quote").send({ product_id: "demo-games-us", face_value: "10.00" });
      expect(cstore.claimOrder({ id, quote_id: qq.body.quote_id, data_source: "mock", network: "eip155:84532", payer: `0x${id.slice(-1).repeat(40)}`, payment_key: `k-${id}`, payment_nonce: null, token_hash: "h" }, { dailyMicro: 1e12, payerDailyOrders: 9 }).ok).toBe(true);
      cstore.db.prepare(`UPDATE gc_orders SET settlement_started=?, status=? WHERE id=?`).run(settlementStarted ? 1 : 0, status, id);
      return qq.body.quote_id as string;
    };
    await mk("o-attempted-1", true, "payment_pending");
    const freeQuote = await mk("o-unattempted-2", false, "payment_pending");
    await mk("o-paid-3", true, "paid");
    expect(cstore.recoverAfterRestart()).toEqual({ uncertain: 1, undelivered: 1 });
    expect(cstore.order("o-attempted-1")!.status).toBe("settlement_uncertain");
    expect(cstore.order("o-unattempted-2")).toBeUndefined();
    expect(cstore.order("o-paid-3")!.status).toBe("refund_pending");
    expect(cstore.quote(freeQuote)!.status).toBe("open");

    expect(cstore.purge(30, new Date(Date.now() + 31 * 86_400_000))).toBe(1);
    expect(cstore.order(o.body.order_id)!.code_sealed).toBeNull();
    const later = await request(app).get(`/api/v1/giftcards/orders/${o.body.order_id}`).set("authorization", `Bearer ${o.body.order_token}`);
    expect(later.body.gift_card).toBeNull();
    expect(later.body.notice).toMatch(/deleted/);
  });
});
