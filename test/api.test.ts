import request from "supertest";
import { keywordMetrics } from "../src/services/keywordMetrics.js";
import { describe, expect, it } from "vitest";
import { buildTestApp, fakeFetch, fixture } from "./helpers.js";

const ROUTE = "/api/v1/keyword-metrics";
const BODY = { keywords: ["running shoes", "trail running shoes"], location_code: 2840, language_code: "en" };

describe("keyword-metrics endpoint (sandbox, payments off)", () => {
  it("serves mapped sandbox data with request id and result token", async () => {
    const ff = fakeFetch(fixture("google-ads-search-volume.json"));
    const { app } = buildTestApp({ fetchImpl: ff.impl });
    const res = await request(app).post(ROUTE).send(BODY).expect(200);
    expect(res.body).toMatchObject({ service: "keyword-metrics", data_source: "sandbox", cached: false });
    expect(res.body.result.keywords[0]).toMatchObject({ keyword: "running shoes", search_volume: 1000 });
    expect(res.body.request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.result_token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(res.headers["x-request-id"]).toBe(res.body.request_id);
    expect(ff.calls).toHaveLength(1);
    expect(JSON.parse(String(ff.calls[0]!.init.body))).toEqual([BODY]);
  });

  it("rejects invalid input without calling DataForSEO", async () => {
    const ff = fakeFetch(fixture("google-ads-search-volume.json"));
    const { app } = buildTestApp({ fetchImpl: ff.impl });
    const res = await request(app).post(ROUTE).send({ keywords: Array.from({ length: 1001 }, (_, i) => `kw ${i}`) }).expect(400);
    expect(res.body.error).toBe("invalid_input");
    await request(app).post(ROUTE).set("content-type", "application/json").send("{not json").expect(400);
    await request(app).post(ROUTE).send({ keywords: ["a".repeat(200_000)] }).expect(413);
    expect(ff.calls).toHaveLength(0);
  });

  it("free preflight validates without calling DataForSEO", async () => {
    const ff = fakeFetch(fixture("google-ads-search-volume.json"));
    const { app } = buildTestApp({ fetchImpl: ff.impl });
    const ok = await request(app).post("/api/v1/preflight/keyword-metrics").send(BODY).expect(200);
    expect(ok.body).toMatchObject({ ok: true, price_usdc: keywordMetrics.priceUsdc });
    expect(ok.body.cached).toBeUndefined(); // would reveal whether an input was bought recently
    const bad = await request(app).post("/api/v1/preflight/keyword-metrics").send({ keywords: [] }).expect(400);
    expect(bad.body.ok).toBe(false);
    await request(app).post("/api/v1/preflight/nope").send({}).expect(404);
    expect(ff.calls).toHaveLength(0);
  });

  it("serves identical requests from cache (one upstream call)", async () => {
    const ff = fakeFetch(fixture("google-ads-search-volume.json"));
    const { app } = buildTestApp({ fetchImpl: ff.impl });
    await request(app).post(ROUTE).send(BODY).expect(200);
    // Same input after normalization (case, whitespace, defaults) -> cache hit
    const same = await request(app).post(ROUTE).send({ keywords: [" RUNNING SHOES", "trail running shoes"] }).expect(200);
    expect(same.body.cached).toBe(true);
    expect(ff.calls).toHaveLength(1);
    // Different location -> new upstream call
    const other = await request(app).post(ROUTE).send({ ...BODY, location_code: 2276, language_code: "de" }).expect(200);
    expect(other.body.cached).toBe(false);
    expect(ff.calls).toHaveLength(2);
  });

  it("collapses concurrent identical requests into one upstream call", async () => {
    const ff = fakeFetch(fixture("google-ads-search-volume.json"), { delayMs: 50 });
    const { app } = buildTestApp({ fetchImpl: ff.impl });
    const results = await Promise.all([1, 2, 3].map(() => request(app).post(ROUTE).send(BODY)));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(ff.calls).toHaveLength(1);
  });

  it("does not retry a failed upstream call and maps the error", async () => {
    const ff = fakeFetch({ status_code: 20000, cost: 0, tasks: [{ status_code: 40501, status_message: "Invalid Field: 'location_code'.", cost: 0 }] });
    const { app, store } = buildTestApp({ fetchImpl: ff.impl });
    const res = await request(app).post(ROUTE).send({ ...BODY, location_code: 2276, language_code: "de" }).expect(422);
    expect(res.body.error).toBe("unsupported_parameters");
    expect(res.body.message).not.toContain("location_code"); // upstream text is not leaked
    expect(ff.calls).toHaveLength(1);
    expect(store.get(res.body.request_id)?.status).toBe("failed");
  });

  it("refuses an unsupported location/language BEFORE any upstream call (nothing to pay for)", async () => {
    const ff = fakeFetch(fixture("google-ads-search-volume.json"));
    const { app } = buildTestApp({ fetchImpl: ff.impl });
    const bad = await request(app).post(ROUTE).send({ ...BODY, location_code: 99999 }).expect(422);
    expect(bad.body).toMatchObject({ error: "unsupported_parameters" });
    expect(bad.body.message).toContain("Nothing was charged");
    const lang = await request(app).post(ROUTE).send({ ...BODY, language_code: "xx" }).expect(422);
    expect(lang.body.message).toContain("language_code");
    expect(ff.calls).toHaveLength(0);
  });

  it("refuses with 503 when the daily budget is exhausted, before any upstream call", async () => {
    const ff = fakeFetch(fixture("google-ads-search-volume.json"));
    const { app } = buildTestApp({ fetchImpl: ff.impl, dailyUsd: 0.05, countSpend: true });
    const res = await request(app).post(ROUTE).send(BODY).expect(503);
    expect(res.body.error).toBe("daily_budget");
    expect(ff.calls).toHaveLength(0);
  });

  it("can be disabled at runtime", async () => {
    const ff = fakeFetch(fixture("google-ads-search-volume.json"));
    const { app } = buildTestApp({ fetchImpl: ff.impl, disabled: ["keyword-metrics"] });
    const res = await request(app).post(ROUTE).send(BODY).expect(503);
    expect(res.body.error).toBe("service_disabled");
    const cat = await request(app).get("/api/v1/services").expect(200);
    expect(cat.body.services[0].enabled).toBe(false);
  });

  it("returns a stored result only with the matching result token", async () => {
    const ff = fakeFetch(fixture("google-ads-search-volume.json"));
    const { app } = buildTestApp({ fetchImpl: ff.impl });
    const first = await request(app).post(ROUTE).send(BODY).expect(200);
    const url = `/api/v1/results/${first.body.request_id}`;
    await request(app).get(url).expect(404);
    await request(app).get(url).set("authorization", "Bearer wrong").expect(404);
    const again = await request(app).get(url).set("authorization", `Bearer ${first.body.result_token}`).expect(200);
    expect(again.body.result).toEqual(first.body.result);
    expect(again.body.result_token).toBeUndefined();
    expect(ff.calls).toHaveLength(1);
  });

  it("lists services with prices and sets security headers", async () => {
    const { app } = buildTestApp({ fetchImpl: fakeFetch({}).impl });
    const res = await request(app).get("/api/v1/services").expect(200);
    expect(res.body.services[0]).toMatchObject({ id: "keyword-metrics", price_usdc: keywordMetrics.priceUsdc, path: ROUTE, max_inputs: 1000 });
    expect(res.headers["x-powered-by"]).toBeUndefined();
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("rate limits per client", async () => {
    const { app } = buildTestApp({ fetchImpl: fakeFetch({}).impl, env: { RATE_LIMIT_PER_MINUTE: "2" } });
    await request(app).get("/api/v1/services").expect(200);
    await request(app).get("/api/v1/services").expect(200);
    await request(app).get("/api/v1/services").expect(429);
  });
});

describe("keyword-metrics at full capacity", () => {
  it("sends 1000 keywords as ONE upstream task and returns all results", async () => {
    const base = fixture("google-ads-search-volume.json");
    const row = base.tasks[0].result[0];
    const keywords = Array.from({ length: 1000 }, (_, i) => `keyword number ${i}`);
    base.tasks[0].result = keywords.map((k) => ({ ...row, keyword: k }));
    const ff = fakeFetch(base);
    const { app } = buildTestApp({ fetchImpl: ff.impl });
    const res = await request(app).post(ROUTE).send({ keywords }).expect(200);
    expect(res.body.result.keywords).toHaveLength(1000);
    expect(ff.calls).toHaveLength(1);
    const sent = JSON.parse(String(ff.calls[0]!.init.body));
    expect(sent).toHaveLength(1);
    expect(sent[0].keywords).toHaveLength(1000);
  });
});
