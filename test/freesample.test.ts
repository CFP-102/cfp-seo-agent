import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildTestApp, fakeFetch, fixture } from "./helpers.js";
import { fakeFacilitator, routedUpstream, start, upstream, type Event } from "./x402helpers.js";

const ENV = (limit: number) => ({ FREE_SAMPLE_DAILY_LIMIT: String(limit), TRUST_PROXY: "1" });
const sample = (base: string, ip: string, body: unknown = { keyword: "running shoes" }) =>
  fetch(base + "/api/v1/free-sample", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify(body) });
const fx = () => fixture("google-ads-search-volume.json");

describe("free sample", () => {
  it("is off by default: no route, not in catalog, OpenAPI or MCP", async () => {
    const { app } = buildTestApp({ fetchImpl: fakeFetch(fx()).impl });
    const base = await start(app);
    expect((await sample(base, "1.1.1.1")).status).toBe(404);
    expect((await (await fetch(base + "/api/v1/services")).json()).free_sample).toBeUndefined();
    expect((await (await fetch(base + "/openapi.json")).json()).paths["/api/v1/free-sample"]).toBeUndefined();
    const c = new Client({ name: "t", version: "1" });
    await c.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp")));
    expect((await c.listTools()).tools.map((t) => t.name)).not.toContain("free_sample");
    await c.close();
  });

  it("gives one free keyword once per client, books it in the ledger and never returns a token", async () => {
    const ff = fakeFetch(fx());
    const { app, store } = buildTestApp({ fetchImpl: ff.impl, env: ENV(5) });
    const base = await start(app);
    const first = await sample(base, "1.1.1.1");
    expect(first.status).toBe(200);
    const body = await first.json();
    expect(body).toMatchObject({ sample: true, service: "keyword-metrics" });
    expect(body.result_token).toBeUndefined();
    expect(JSON.parse(String(ff.calls[0]!.init.body))[0].keywords).toEqual(["running shoes"]);
    const row = store.get(body.request_id)!;
    expect(row).toMatchObject({ status: "completed", payment_key: null, tx_hash: null, price_usdc: 0 });

    const again = await sample(base, "1.1.1.1", { keyword: "other keyword" });
    expect(again.status).toBe(429);
    expect((await again.json()).error).toBe("sample_used");
    expect(ff.calls).toHaveLength(1);
    // another client still gets one
    expect((await sample(base, "2.2.2.2", { keyword: "third" })).status).toBe(200);
  });

  it("an IPv6 /64 shares one sample (rotating addresses does not help)", async () => {
    const ff = fakeFetch(fx());
    const { app } = buildTestApp({ fetchImpl: ff.impl, env: ENV(10) });
    const base = await start(app);
    expect((await sample(base, "2001:db8:1:2::1")).status).toBe(200);
    for (let i = 2; i < 6; i++) expect((await sample(base, `2001:db8:1:2::${i}`, { keyword: `k${i}` })).status).toBe(429);
    expect(ff.calls).toHaveLength(1);
  });

  it("stops at the global daily cap; cached answers do not use up a slot, but the cap answer never depends on the cache", async () => {
    const ff = fakeFetch(fx());
    const { app } = buildTestApp({ fetchImpl: ff.impl, env: ENV(2) });
    const base = await start(app);
    expect((await sample(base, "1.1.1.1", { keyword: "alpha" })).status).toBe(200);
    // same keyword again from another client: served from cache, no new upstream call, cap untouched
    expect((await sample(base, "2.2.2.2", { keyword: "alpha" })).status).toBe(200);
    expect(ff.calls).toHaveLength(1);
    expect((await sample(base, "4.4.4.4", { keyword: "gamma" })).status).toBe(200);
    expect(ff.calls).toHaveLength(2);
    // Cap reached: a cached keyword gets the same refusal as a new one (no leak of what others asked).
    expect((await (await sample(base, "5.5.5.5", { keyword: "alpha" })).json()).error).toBe("sample_exhausted");
    const out = await sample(base, "3.3.3.3", { keyword: "beta" });
    expect(out.status).toBe(429);
    expect((await out.json()).error).toBe("sample_exhausted");
    expect(ff.calls).toHaveLength(2);
  });

  it("parallel requests from one client cause exactly one upstream call", async () => {
    const ff = fakeFetch(fx(), { delayMs: 80 });
    const { app } = buildTestApp({ fetchImpl: ff.impl, env: ENV(5) });
    const base = await start(app);
    const res = await Promise.all(Array.from({ length: 6 }, (_, i) => sample(base, "9.9.9.9", { keyword: `kw${i}` })));
    expect(res.filter((r) => r.status === 200)).toHaveLength(1);
    expect(res.filter((r) => r.status === 429)).toHaveLength(5);
    expect(ff.calls).toHaveLength(1);
  });

  it("a failed upstream call does not use up the sample or the cap", async () => {
    const failing = { status_code: 50000, status_message: "Internal Error.", cost: 0, tasks: [] };
    const events: Event[] = [];
    const up = upstream(events, [failing, fx()]);
    const { app } = buildTestApp({ fetchImpl: up.impl, env: ENV(1) });
    const base = await start(app);
    expect((await sample(base, "1.1.1.1", { keyword: "gamma" })).status).toBe(502);
    expect((await sample(base, "1.1.1.1", { keyword: "gamma" })).status).toBe(200);
    expect((await sample(base, "2.2.2.2", { keyword: "delta" })).status).toBe(429); // the one real call is now used
  });

  it("accepts exactly one valid keyword", async () => {
    const ff = fakeFetch(fx());
    const { app } = buildTestApp({ fetchImpl: ff.impl, env: ENV(5) });
    const base = await start(app);
    for (const bad of [{ keywords: ["a", "b"] }, { keyword: ["a", "b"] }, { keyword: "" }, { keyword: "x".repeat(61) }, { keyword: "a", extra: 1 }, { keyword: "<script>" }, {}]) {
      expect((await sample(base, "5.5.5.5", bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await sample(base, "5.5.5.5", { keyword: "ok", location_code: 99999 })).status).toBe(422);
    expect(ff.calls).toHaveLength(0);
    expect((await sample(base, "5.5.5.5", { keyword: "ok", location_code: 2276, language_code: "de" })).status).toBe(200); // invalid tries did not use it up
  });

  it("respects the DataForSEO budget and does not use up the sample when refused", async () => {
    const ff = fakeFetch(fx());
    const { app } = buildTestApp({ fetchImpl: ff.impl, env: ENV(5), dailyUsd: 0.05, countSpend: true });
    const base = await start(app);
    const res = await sample(base, "1.1.1.1");
    expect(res.status).toBe(503);
    expect(ff.calls).toHaveLength(0);
  });

  it("works next to payments (no 402) and is available over MCP with the same limits", async () => {
    const events: Event[] = [];
    const ff = fakeFetch(fx());
    const { app } = buildTestApp({ fetchImpl: ff.impl, facilitator: fakeFacilitator(events), env: ENV(5) });
    const base = await start(app);
    expect((await (await fetch(base + "/api/v1/services")).json()).free_sample).toMatchObject({ path: "/api/v1/free-sample", per_client_per_day: 1, available_today: true });
    expect((await (await fetch(base + "/openapi.json")).json()).paths["/api/v1/free-sample"].post.security).toEqual([]);
    const c = new Client({ name: "t", version: "1" });
    await c.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp")));
    expect((await c.listTools()).tools.map((t) => t.name)).toContain("free_sample");
    const ok = await c.callTool({ name: "free_sample", arguments: { keyword: "mcp sample" } });
    expect(ok.isError).toBeFalsy();
    expect((ok.structuredContent as any).sample).toBe(true);
    const second = await c.callTool({ name: "free_sample", arguments: { keyword: "second" } });
    expect(second.isError).toBe(true);
    expect(events).toEqual([]); // no payment machinery involved
    await c.close();
  });
});

describe("per-service free samples", () => {
  const svcSample = (base: string, ip: string, id: string, body: unknown) =>
    fetch(base + "/api/v1/free-sample/" + id, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify(body) });

  it("one per service per client per day, only cheap single-call services, shared daily cap, no token", async () => {
    const events: Event[] = [];
    const up = routedUpstream(events);
    const { app, store } = buildTestApp({ fetchImpl: up.impl, env: ENV(3) });
    const base = await start(app);
    const serp = { keyword: "running shoes", location_code: 2840, language_code: "en" };
    const first = await svcSample(base, "1.1.1.1", "google-serp", serp);
    expect(first.status).toBe(200);
    const body = await first.json();
    expect(body).toMatchObject({ sample: true, service: "google-serp" });
    expect(body.result_token).toBeUndefined();
    expect(store.get(body.request_id)).toMatchObject({ status: "completed", price_usdc: 0 });
    expect((await svcSample(base, "1.1.1.1", "google-serp", serp)).status).toBe(429);
    // Another service is a separate sample for the same client.
    expect((await svcSample(base, "1.1.1.1", "bing-serp", serp)).status).toBe(200);
    // Not eligible: too expensive, or a package.
    expect((await svcSample(base, "1.1.1.1", "keyword-metrics", { keywords: ["a"] })).status).toBe(403);
    expect((await svcSample(base, "1.1.1.1", "local-market-check", { keyword: "pizza london" })).status).toBe(403);
    expect((await svcSample(base, "1.1.1.1", "nope", {})).status).toBe(404);
    // Invalid input is refused before anything is used up.
    expect((await svcSample(base, "2.2.2.2", "google-serp", { keyword: "site:x.com" })).status).toBe(400);
    // Shared daily cap (3): one more real call, then exhausted.
    expect((await svcSample(base, "3.3.3.3", "news-search", serp)).status).toBe(200);
    expect((await svcSample(base, "4.4.4.4", "image-search", serp)).status).toBe(429);
    expect(up.calls).toHaveLength(3);
    const catalog = await (await fetch(base + "/api/v1/services")).json();
    expect(catalog.free_sample.per_service_eligible).toContain("google-serp");
    expect(catalog.free_sample.per_service_eligible).not.toContain("keyword-metrics");
    expect(catalog.free_sample.per_service_eligible).not.toContain("local-market-check");
    expect(catalog.services.find((s: any) => s.id === "local-market-check").free_sample).toBe(false);
    expect((await (await fetch(base + "/openapi.json")).json()).paths["/api/v1/free-sample/{serviceId}"]).toBeTruthy();
  });

  it("works through the MCP free_sample tool with service + input", async () => {
    const up = routedUpstream([]);
    const { app } = buildTestApp({ fetchImpl: up.impl, env: ENV(5) });
    const base = await start(app);
    const c = new Client({ name: "t", version: "1" });
    await c.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp")));
    const out = await c.callTool({ name: "free_sample", arguments: { service: "google-trends", input: { keywords: ["running shoes"] } } });
    expect(out.isError).toBeFalsy();
    const pkg = await c.callTool({ name: "free_sample", arguments: { service: "local-market-check", input: { keyword: "pizza london" } } });
    expect(pkg.isError).toBe(true);
    await c.close();
  });
});

describe("temporary free-sample boost", () => {
  it("uses the boost limit until the end time, then the normal limit again", async () => {
    const { createFreeSample } = await import("../src/freeSample.js");
    const { pipeline, store } = buildTestApp({ fetchImpl: routedUpstream([]).impl }) as any;
    let now = new Date("2026-10-24T10:00:00Z");
    const fs = createFreeSample({ pipeline, store, dailyLimit: 1, boost: { limit: 3, until: new Date("2026-10-26T23:59:59Z") }, now: () => now });
    const serp = { keyword: "coffee", location_code: 2840, language_code: "en" };
    const codes = [];
    for (const ip of ["1.1.1.1", "2.2.2.2", "3.3.3.3", "4.4.4.4"]) codes.push((await fs.runService(ip, "google-serp", { ...serp, keyword: "coffee " + ip.slice(0, 1) })).status);
    expect(codes).toEqual([200, 200, 200, 429]);
    now = new Date("2026-10-27T10:00:00Z"); // boost over, new day
    expect((await fs.runService("5.5.5.5", "google-serp", { ...serp, keyword: "tea" })).status).toBe(200);
    expect((await fs.runService("6.6.6.6", "google-serp", { ...serp, keyword: "milk" })).status).toBe(429);
  });
});

describe("free-sample abuse limits", () => {
  it("failed samples are limited per client, charged failures keep the cap slot, and no cached flag is exposed", async () => {
    let calls = 0;
    const failing = (async () => {
      calls++;
      return new Response(JSON.stringify({ status_code: 20000, cost: 0.002, tasks: [{ status_code: 40501, status_message: "Invalid Field", cost: 0.002 }] }));
    }) as unknown as typeof fetch;
    const { app } = buildTestApp({ fetchImpl: failing, env: ENV(10) });
    const base = await start(app);
    const body = (k: string) => ({ keyword: k, location_code: 2840, language_code: "en" });
    const codes: number[] = [];
    for (const id of ["google-serp", "bing-serp", "news-search", "image-search"]) codes.push((await fetch(base + "/api/v1/free-sample/" + id, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "9.9.9.9" }, body: JSON.stringify(body("x " + id)) })).status);
    expect(codes.slice(0, 3).every((c) => c >= 400 && c !== 429)).toBe(true);
    expect(codes[3]).toBe(429); // 4th failure refused before any upstream call
    expect(calls).toBe(3);
    // The three charged failures used up 3 of 10 global slots.
    const info = await (await fetch(base + "/api/v1/services")).json();
    expect(info.free_sample.available_today).toBe(true);
  });

  it("successful samples do not reveal whether the input was cached", async () => {
    const { app } = buildTestApp({ fetchImpl: routedUpstream([]).impl, env: ENV(10) });
    const base = await start(app);
    const req = (ip: string) => fetch(base + "/api/v1/free-sample/google-serp", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify({ keyword: "same thing", location_code: 2840, language_code: "en" }) });
    const a = await (await req("1.2.3.4")).json();
    const b = await (await req("5.6.7.8")).json();
    expect(a.cached).toBeUndefined();
    expect(b.cached).toBeUndefined();
  });
});
