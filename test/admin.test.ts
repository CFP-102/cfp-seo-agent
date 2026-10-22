import { describe, expect, it } from "vitest";
import { credentialsMatch } from "../src/admin.js";
import { buildTestApp, PAY_TO } from "./helpers.js";
import { buyer, fakeFacilitator, post, routedUpstream, start, type Event } from "./x402helpers.js";

const basic = (user: string, pass: string) => "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
const PASSWORD = "correct-horse-battery-staple-123";
const adminEnv = { ADMIN_USER: "boss", ADMIN_PASSWORD: PASSWORD, PAYMENT_MODE: "testnet", PAY_TO_ADDRESS: PAY_TO, DATAFORSEO_LOGIN: "l", DATAFORSEO_PASSWORD: "p" };

describe("credentialsMatch", () => {
  it("accepts only the exact user and password", () => {
    expect(credentialsMatch(basic("boss", PASSWORD), "boss", PASSWORD)).toBe(true);
    expect(credentialsMatch(basic("boss", PASSWORD + "x"), "boss", PASSWORD)).toBe(false);
    expect(credentialsMatch(basic("Boss", PASSWORD), "boss", PASSWORD)).toBe(false);
    expect(credentialsMatch(basic("", ""), "boss", PASSWORD)).toBe(false);
    expect(credentialsMatch(undefined, "boss", PASSWORD)).toBe(false);
    expect(credentialsMatch("Bearer abc", "boss", PASSWORD)).toBe(false);
    expect(credentialsMatch("Basic " + Buffer.from("boss").toString("base64"), "boss", PASSWORD)).toBe(false); // no colon
    expect(credentialsMatch("Basic %%%not-base64%%%", "boss", PASSWORD)).toBe(false);
  });
  it("never accepts anything when no password is configured", () => {
    expect(credentialsMatch(basic("boss", ""), "boss", "")).toBe(false);
    expect(credentialsMatch(basic("", ""), "", "")).toBe(false);
  });
  it("passwords containing colons work", () => {
    expect(credentialsMatch(basic("boss", "a:b:c"), "boss", "a:b:c")).toBe(true);
  });
});

describe("/admin", () => {
  it("does not exist without ADMIN_PASSWORD (404 on every admin path)", async () => {
    const { app } = buildTestApp({ fetchImpl: routedUpstream([]).impl });
    const base = await start(app);
    for (const p of ["/admin", "/admin/", "/admin/stats.json", "/admin/anything"]) {
      const res = await fetch(base + p, { headers: { authorization: basic("admin", "") } });
      expect(res.status, p).toBe(404);
    }
  });

  it("requires credentials, sends no-store/noindex and never leaks data to wrong credentials", async () => {
    const { app } = buildTestApp({ fetchImpl: routedUpstream([]).impl, env: adminEnv });
    const base = await start(app);
    for (const auth of [undefined, basic("boss", "wrong"), basic("admin", PASSWORD), "Basic !!!"]) {
      const res = await fetch(base + "/admin/stats.json", { headers: auth ? { authorization: auth } : {} });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toMatch(/^Basic realm="admin"/);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.text()).not.toMatch(/revenue|payer|tx_hash/);
    }
    const ok = await fetch(base + "/admin/stats.json", { headers: { authorization: basic("boss", PASSWORD) } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("x-robots-tag")).toMatch(/noindex/);
  });

  it("throttles password guessing by failures only: the right password keeps working until the client collects 10 failures", async () => {
    const { app } = buildTestApp({ fetchImpl: routedUpstream([]).impl, env: adminEnv });
    const base = await start(app);
    // 50 successful requests never lock anybody out (a stranger hammering cannot block the owner).
    for (let i = 0; i < 50; i++) expect((await fetch(base + "/admin/stats.json", { headers: { authorization: basic("boss", PASSWORD) } })).status).toBe(200);
    const codes: number[] = [];
    for (let i = 0; i < 14; i++) codes.push((await fetch(base + "/admin", { headers: { authorization: basic("boss", `guess${i}`) } })).status);
    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
    expect(codes.slice(10).every((c) => c === 429)).toBe(true);
    // Once blocked, even the correct password is refused (brute force cannot continue).
    const blocked = await fetch(base + "/admin", { headers: { authorization: basic("boss", PASSWORD) } });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("60");
  });

  it("shows paid revenue, DataForSEO cost, margin, per-endpoint counts and separates test money from real money", async () => {
    const events: Event[] = [];
    const { app, store } = buildTestApp({ fetchImpl: routedUpstream(events).impl, facilitator: fakeFacilitator(events), env: adminEnv });
    const base = await start(app);
    const { pay } = buyer();
    expect((await pay(base + "/api/v1/keyword-ideas", post({ keywords: ["running shoes"] }))).status).toBe(200);
    expect((await pay(base + "/api/v1/search-intent", post({ keywords: ["login page"] }))).status).toBe(200);
    await fetch(base + "/api/v1/competitors", post({})); // crawler probe: counted, not paid
    // A paid request that failed after settlement must show up as "needs attention".
    store.claim({ id: "lost", service_id: "keyword-metrics", data_source: "live", price_usdc: 0.12, payment_key: "pk-lost", network: "eip155:8453", payer: "0xabc", input_hash: "h", input_json: "{}", result_token_hash: "t" });
    store.setSettled("lost", "0xdeadbeef", "0xabc");
    store.fail("lost", "50000", 0);

    const json = await (await fetch(base + "/admin/stats.json", { headers: { authorization: basic("boss", PASSWORD) } })).json();
    expect(json.mode).toEqual({ data_source: "sandbox", payments: "testnet" });
    expect(json.day.totals.paid).toBe(3);
    const test = json.day.per_network.find((r: any) => r.network === "eip155:84532");
    expect(test).toMatchObject({ real_money: false, paid: 2, approx_margin_usd: null });
    expect(test.revenue_usdc).toBeCloseTo(0.025 + 0.04);
    const real = json.day.per_network.find((r: any) => r.network === "eip155:8453");
    expect(real).toMatchObject({ real_money: true, paid: 1 });
    expect(real.revenue_usdc).toBeCloseTo(0.12);
    expect(real.approx_margin_usd).toBeCloseTo(0.12);
    const byService = Object.fromEntries(json.day.per_service.map((r: any) => [r.service_id, r]));
    expect(byService["keyword-ideas"]).toMatchObject({ paid: 1, completed: 1 });
    expect(json.day.counters.some((c: any) => c.service_id === "competitors" && c.kind === "probe")).toBe(true);
    expect(json.needs_attention).toHaveLength(1);
    expect(json.needs_attention[0]).toMatchObject({ id: "lost", tx_hash: "0xdeadbeef", status: "failed" });
    expect(json.budget).toMatchObject({ daily_limit_usd: 5, monthly_limit_usd: 100 });
    // No IPs, headers or raw keywords in the statistics.
    expect(JSON.stringify(json)).not.toMatch(/running shoes|127\.0\.0\.1|::1|user-agent/i);

    const page = await fetch(base + "/admin", { headers: { authorization: basic("boss", PASSWORD) } });
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
    const html = await page.text();
    expect(html).toContain("Needs attention");
    expect(html).toContain("0xdeadbeef");
    expect(html).toContain("(test)");
    expect(html).not.toMatch(/<script(?![^>]*\bsrc="\/admin\.js")/i); // only the same-origin helper script, nothing inline
  });

  it("shows history, margin per service, buyers and a CSV export for real money only", async () => {
    const { app, store } = buildTestApp({ fetchImpl: routedUpstream([]).impl, env: adminEnv });
    const base = await start(app);
    const row = (id: string, service: string, price: number, payer: string, network: string, cost: number) => {
      store.claim({ id, service_id: service, data_source: "live", price_usdc: price, payment_key: "pk-" + id, network, payer, input_hash: "h", input_json: "{}", result_token_hash: "t" });
      store.setSettled(id, "0x" + id, payer);
      store.complete(id, { resultJson: "{}", upstreamCostUsd: cost, cacheHit: false });
    };
    row("a1", "keyword-ideas", 0.025, "0xAAA", "eip155:8453", 0.0136);
    row("a2", "keyword-ideas", 0.025, "0xAAA", "eip155:8453", 0.0136);
    row("b1", "search-intent", 0.04, "0xBBB", "eip155:8453", 0.05); // loses money
    row("t1", "keyword-ideas", 0.025, "0xTEST", "eip155:84532", 0);
    const auth = { headers: { authorization: basic("boss", PASSWORD) } };
    const json = await (await fetch(base + "/admin/stats.json", auth)).json();
    expect(json.history).toHaveLength(30);
    const todayRow = json.history.at(-1);
    expect(todayRow.paid).toBe(3);
    expect(todayRow.revenue_usdc).toBeCloseTo(0.09);
    const ideas = json.margins.find((m: any) => m.service_id === "keyword-ideas");
    expect(ideas).toMatchObject({ paid: 2, flag: "" });
    expect(ideas.margin_usd).toBeCloseTo(0.05 - 0.0272);
    expect(json.margins.find((m: any) => m.service_id === "search-intent").flag).toBe("cost >= price");
    expect(json.buyers).toMatchObject({ buyers: 2, repeat_buyers: 1 });
    expect(JSON.stringify(json.buyers)).not.toContain("0xTEST");

    const html = await (await fetch(base + "/admin", auth)).text();
    expect(html).toContain("<svg");
    expect(html).toContain("Margin and reliability per service");
    expect(html).not.toMatch(/<script(?![^>]*\bsrc="\/admin\.js")|style=/i);

    const csv = await fetch(base + "/admin/payments.csv", auth);
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(csv.headers.get("content-disposition")).toContain("payments-");
    const lines = (await csv.text()).trim().split("\n");
    expect(lines[0]).toBe("time_utc,service,amount,asset,network,payer,tx_hash,status");
    expect(lines).toHaveLength(4); // header + 3 mainnet payments, no test money
    expect((await fetch(base + "/admin/payments.csv")).status).toBe(401);
    expect((await fetch(base + "/admin/payments.csv?month=bad", auth)).status).toBe(200); // falls back to this month
  });

  it("escapes values rendered in the admin page", async () => {
    const { app, store } = buildTestApp({ fetchImpl: routedUpstream([]).impl, env: adminEnv });
    const base = await start(app);
    store.claim({ id: "x1", service_id: "<img src=x onerror=alert(1)>", data_source: "live", price_usdc: 0.1, payment_key: "pk-x", network: "eip155:8453", payer: "<b>p</b>", input_hash: "h", input_json: "{}", result_token_hash: "t" });
    store.setSettled("x1", "0x1", null);
    store.fail("x1", "e<script>", 0);
    const html = await (await fetch(base + "/admin", { headers: { authorization: basic("boss", PASSWORD) } })).text();
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;img src=x");
  });

  it("is not reachable through the website's static handler", async () => {
    const { app } = buildTestApp({ fetchImpl: routedUpstream([]).impl, env: adminEnv });
    const base = await start(app);
    // Stylesheet and helper script are public static files: they must contain no data, only presentation and DOM code.
    for (const file of ["/admin.css", "/admin.js"]) {
      const res = await fetch(base + file);
      expect(res.status, file).toBe(200);
      const text = await res.text();
      expect(text.length, file).toBeLessThan(20_000);
      expect(text, file).not.toContain(PASSWORD);
      expect(text, file).not.toMatch(/0x[0-9a-fA-F]{40}|fetch\(|XMLHttpRequest/);
    }
  });
});
