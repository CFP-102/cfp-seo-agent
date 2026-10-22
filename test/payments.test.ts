/**
 * x402 integration tests: REAL @x402/express middleware + REAL @x402/fetch buyer client signing
 * EIP-3009 authorizations with a throwaway local key. Only the facilitator is simulated
 * (it enforces single-use nonces like the USDC contract does on-chain). No network, no real funds.
 */
import { describe, expect, it } from "vitest";
import { decodePaymentResponseHeader } from "@x402/fetch";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { buildTestApp, fakeFetch, fixture, PAY_TO } from "./helpers.js";
import { buyer, fakeFacilitator, post, routedUpstream, SEPOLIA_USDC, start, upstream, type Event } from "./x402helpers.js";
import { keywordMetrics } from "../src/services/keywordMetrics.js";
import { SERVICES } from "../src/services/index.js";

const ROUTE = "/api/v1/keyword-metrics";
const BODY = { keywords: ["running shoes"], location_code: 2840, language_code: "en" };

describe("x402 payments (testnet config, simulated facilitator)", () => {
  it("answers an unpaid request with a correct v2 402 challenge and does not call DataForSEO", async () => {
    const events: Event[] = [];
    const ff = upstream(events);
    const { app, store } = buildTestApp({ fetchImpl: ff.impl, facilitator: fakeFacilitator(events) });
    const base = await start(app);
    const res = await fetch(base + ROUTE, post(BODY));
    expect(res.status).toBe(402);
    const required = decodePaymentRequiredHeader(res.headers.get("payment-required")!);
    expect(required.x402Version).toBe(2);
    expect(required.resource?.url).toBe("http://api.test" + ROUTE);
    expect(required.accepts[0]).toMatchObject({
      scheme: "exact",
      network: "eip155:84532",
      amount: String(Math.round(Number(keywordMetrics.priceUsdc) * 1e6)),
      asset: SEPOLIA_USDC,
      payTo: PAY_TO,
    });
    expect(required.accepts[0]!.extra).toMatchObject({ paymentFlow: "upfront" });
    expect(events).toEqual([]);
    expect(store.stats("day").perService).toEqual([]);
  });

  it("refuses invalid input or exhausted budget BEFORE issuing a 402", async () => {
    const events: Event[] = [];
    const { app } = buildTestApp({ fetchImpl: upstream(events).impl, facilitator: fakeFacilitator(events), dailyUsd: 0.01, countSpend: true });
    const base = await start(app);
    expect((await fetch(base + ROUTE, post({ keywords: [] }))).status).toBe(400);
    const budget = await fetch(base + ROUTE, post(BODY));
    expect(budget.status).toBe(503);
    expect(budget.headers.get("payment-required")).toBeNull();
    expect(events).toEqual([]);
  });

  it("settles BEFORE calling DataForSEO, exactly once, and records the payment", async () => {
    const events: Event[] = [];
    const fac = fakeFacilitator(events);
    const { app, store } = buildTestApp({ fetchImpl: upstream(events).impl, facilitator: fac });
    const base = await start(app);
    const { pay } = buyer();
    const res = await pay(base + ROUTE, post(BODY));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.keywords[0].keyword).toBe("running shoes");
    // Upfront flow: the facilitator validates during settle (no separate verify), then our handler runs.
    expect(events).toEqual(["settle", "upstream"]);
    const receipt = decodePaymentResponseHeader(res.headers.get("payment-response")!);
    expect(receipt).toMatchObject({ success: true, network: "eip155:84532" });
    const row = store.get(body.request_id)!;
    expect(row).toMatchObject({ status: "completed", tx_hash: receipt.transaction, network: "eip155:84532", price_usdc: Number(keywordMetrics.priceUsdc) });
    expect(row.payer).toMatch(/^0x[0-9a-f]{40}$/);
    const stats = store.stats("day").perService[0] as { paid: number; revenue_usdc: number };
    expect(stats.paid).toBe(1);
    expect(stats.revenue_usdc).toBeCloseTo(Number(keywordMetrics.priceUsdc));
  });

  it("replaying the same payment returns the stored result without settling or calling upstream again", async () => {
    const events: Event[] = [];
    const fac = fakeFacilitator(events);
    const { app } = buildTestApp({ fetchImpl: upstream(events).impl, facilitator: fac });
    const base = await start(app);
    const { pay, sent } = buyer();
    const first = await (await pay(base + ROUTE, post(BODY))).json();
    const signature = sent.map((h) => h.get("payment-signature")).find(Boolean)!;
    expect(signature).toBeTruthy();

    const again = await fetch(base + ROUTE, post(BODY, { "payment-signature": signature }));
    expect(again.status).toBe(200);
    const replay = await again.json();
    expect(replay).toMatchObject({ request_id: first.request_id, replayed: true });
    expect(replay.result).toEqual(first.result);
    expect(replay.result_token).not.toBe(first.result_token);
    expect(events.filter((e) => e === "upstream")).toHaveLength(1);
    expect(fac.settles()).toBe(1);

    // Same payment for a different body is rejected.
    const other = await fetch(base + ROUTE, post({ ...BODY, keywords: ["other"] }, { "payment-signature": signature }));
    expect(other.status).toBe(409);
    expect((await other.json()).error).toBe("payment_already_used");
  });

  it("concurrent submissions of one payment trigger one settlement and one upstream call", async () => {
    const events: Event[] = [];
    const fac = fakeFacilitator(events);
    const { app } = buildTestApp({ fetchImpl: upstream(events).impl, facilitator: fac });
    const base = await start(app);
    const { pay, sent } = buyer();
    await pay(base + ROUTE, post({ ...BODY, keywords: ["warmup"] }));
    // Build a fresh signed payment by letting the client pay once more, then replay it in parallel.
    const before = sent.length;
    await pay(base + ROUTE, post(BODY));
    const sig = sent.slice(before).map((h) => h.get("payment-signature")).find(Boolean)!;
    const results = await Promise.all([1, 2, 3].map(() => fetch(base + ROUTE, post(BODY, { "payment-signature": sig }))));
    expect(results.map((r) => r.status).every((s) => s === 200 || s === 409)).toBe(true);
    expect(fac.settles()).toBe(2);
    expect(events.filter((e) => e === "upstream")).toHaveLength(2);
  });

  it("does not call DataForSEO when settlement fails, and retains a reviewable claim", async () => {
    const events: Event[] = [];
    const { app, store } = buildTestApp({ fetchImpl: upstream(events).impl, facilitator: fakeFacilitator(events, { failSettle: true }) });
    const base = await start(app);
    const { pay } = buyer();
    const res = await pay(base + ROUTE, post(BODY));
    expect(res.status).toBe(402);
    expect(events).not.toContain("upstream");
    expect(store.stats("day").perService).toMatchObject([{ paid: 0, revenue_usdc: 0, failed: 1 }]);
    expect(store.needsAttention()).toMatchObject([{ error_code: "settlement_uncertain" }]);
  });

  it("an upstream failure after payment is reported with a token and can be retried once for free", async () => {
    const events: Event[] = [];
    const failing = { status_code: 50000, status_message: "Internal Error.", cost: 0, tasks: [] };
    const fac = fakeFacilitator(events);
    const { app, store } = buildTestApp({ fetchImpl: upstream(events, [failing, fixture("google-ads-search-volume.json")]).impl, facilitator: fac });
    const base = await start(app);
    const { pay } = buyer();
    const res = await pay(base + ROUTE, post(BODY));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body).toMatchObject({ error: "upstream_error", paid: true, retry_available: true });
    expect(decodePaymentResponseHeader(res.headers.get("payment-response")!).success).toBe(true);
    expect(store.get(body.request_id)).toMatchObject({ status: "failed" });

    const auth = { authorization: `Bearer ${body.result_token}` };
    const state = await (await fetch(`${base}/api/v1/results/${body.request_id}`, { headers: auth })).json();
    expect(state).toMatchObject({ status: "failed", paid: true, retry_available: true });

    expect((await fetch(`${base}/api/v1/results/${body.request_id}/retry`, { method: "POST" })).status).toBe(404);
    const retry = await fetch(`${base}/api/v1/results/${body.request_id}/retry`, { method: "POST", headers: auth });
    expect(retry.status).toBe(200);
    expect((await retry.json()).result.keywords[0].keyword).toBe("running shoes");
    const second = await fetch(`${base}/api/v1/results/${body.request_id}/retry`, { method: "POST", headers: auth });
    expect(second.status).toBe(409);
    expect(fac.settles()).toBe(1);
    expect(events.filter((e) => e === "upstream")).toHaveLength(2);
  });

  it("rejects a payment signed for a different price", async () => {
    const events: Event[] = [];
    const { app } = buildTestApp({ fetchImpl: upstream(events).impl, facilitator: fakeFacilitator(events) });
    const base = await start(app);
    const challenge = decodePaymentRequiredHeader((await fetch(base + ROUTE, post(BODY))).headers.get("payment-required")!);
    const forged = { x402Version: 2, accepted: { ...challenge.accepts[0], amount: "1" }, payload: { signature: "0x00", authorization: { from: PAY_TO, to: PAY_TO, value: "1", validAfter: "0", validBefore: "9999999999", nonce: "0x" + "1".repeat(64) } } };
    const res = await fetch(base + ROUTE, post(BODY, { "payment-signature": Buffer.from(JSON.stringify(forged)).toString("base64") }));
    expect(res.status).toBe(400); // rejected locally, before anything is reserved or the facilitator is called
    expect((await res.json()).error).toBe("invalid_payment");
    expect(events).not.toContain("upstream");
    expect(events).not.toContain("settle");
  });
});

// ---------------------------------------------------------------------------------------------
// All six services through the same payment architecture
// ---------------------------------------------------------------------------------------------
describe("all nine services over x402", () => {
  it("every route issues a v2 402 for exactly its configured price and payTo", async () => {
    const events: Event[] = [];
    const up = routedUpstream(events);
    const { app } = buildTestApp({ fetchImpl: up.impl, facilitator: fakeFacilitator(events) });
    const base = await start(app);
    for (const s of SERVICES) {
      const res = await fetch(base + s.route, post(s.example));
      expect(res.status, s.id).toBe(402);
      const required = decodePaymentRequiredHeader(res.headers.get("payment-required")!);
      expect(required.accepts[0], s.id).toMatchObject({
        scheme: "exact",
        network: "eip155:84532",
        amount: String(Math.round(Number(s.priceUsdc) * 1e6)),
        asset: SEPOLIA_USDC,
        payTo: PAY_TO,
      });
      expect(required.accepts[0]!.extra, s.id).toMatchObject({ paymentFlow: "upfront" });
      expect(required.resource?.url, s.id).toBe("http://api.test" + s.route);
    }
    expect(events).toEqual([]);
  });

  it("every route: pay -> settle BEFORE upstream -> exactly one task to the configured endpoint -> mapped result", async () => {
    const events: Event[] = [];
    const up = routedUpstream(events);
    const fac = fakeFacilitator(events);
    const { app, store } = buildTestApp({ fetchImpl: up.impl, facilitator: fac });
    const base = await start(app);
    const { pay } = buyer();
    for (const s of SERVICES) {
      events.length = 0;
      up.calls.length = 0;
      const res = await pay(base + s.route, post(s.example));
      expect(res.status, s.id).toBe(200);
      const body = await res.json();
      expect(events, s.id).toEqual(["settle", "upstream"]);
      expect(up.calls, s.id).toHaveLength(1);
      expect(up.calls[0]!.endpoint, s.id).toBe(s.upstream.endpoint);
      expect(Array.isArray(up.calls[0]!.body) && (up.calls[0]!.body as unknown[]).length, s.id).toBe(1);
      expect(body, s.id).toMatchObject({ service: s.id, data_source: "sandbox", cached: false });
      expect(body.result, s.id).toBeTruthy();
      expect(store.get(body.request_id), s.id).toMatchObject({ status: "completed", price_usdc: Number(s.priceUsdc) });
      expect(decodePaymentResponseHeader(res.headers.get("payment-response")!).success, s.id).toBe(true);
      if (s.id === "ai-keyword-demand") {
        expect(body.notice).toMatch(/estimate/i);
        expect(body.result.estimate).toBe(true);
      }
    }
    expect(fac.settles()).toBe(SERVICES.length);
    const stats = store.stats("day").perService as { service_id: string; paid: number }[];
    expect(stats.map((r) => r.service_id).sort()).toEqual(SERVICES.map((s) => s.id).sort());
    expect(stats.every((r) => r.paid === 1)).toBe(true);
  });

  it("unsupported location/language pairs and SERP operators are refused BEFORE a 402 is issued", async () => {
    const events: Event[] = [];
    const up = routedUpstream(events);
    const { app } = buildTestApp({ fetchImpl: up.impl, facilitator: fakeFacilitator(events) });
    const base = await start(app);
    const localized = SERVICES.filter((s) => "location_code" in (s.example as object));
    expect(localized.map((s) => s.id).sort()).toEqual(["ai-keyword-demand", "competitors", "domain-overview", "google-serp", "keyword-difficulty", "keyword-ideas", "keyword-metrics", "ranked-keywords"]);
    for (const s of localized) {
      const res = await fetch(base + s.route, post({ ...(s.example as object), location_code: 99999 }));
      expect(res.status, s.id).toBe(422);
      expect(res.headers.get("payment-required"), s.id).toBeNull();
      expect((await res.json()).message, s.id).toContain("Nothing was charged");
    }
    const labsMismatch = await fetch(base + "/api/v1/competitors", post({ domain: "example.com", location_code: 2276, language_code: "en" }));
    expect(labsMismatch.status).toBe(422);
    expect(labsMismatch.headers.get("payment-required")).toBeNull();
    const op = await fetch(base + "/api/v1/google-serp", post({ keyword: "site:example.com shoes" }));
    expect(op.status).toBe(400);
    expect(op.headers.get("payment-required")).toBeNull();
    expect(events).toEqual([]);
  });

  it("a service switched off is refused before any 402", async () => {
    const events: Event[] = [];
    const { app } = buildTestApp({ fetchImpl: routedUpstream(events).impl, facilitator: fakeFacilitator(events), disabled: ["competitors"] });
    const base = await start(app);
    const res = await fetch(base + "/api/v1/competitors", post({ domain: "example.com" }));
    expect(res.status).toBe(503);
    expect(res.headers.get("payment-required")).toBeNull();
    const ok = await fetch(base + "/api/v1/search-intent", post({ keywords: ["a"] }));
    expect(ok.status).toBe(402);
  });
});
