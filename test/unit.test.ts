import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { FACILITATOR_FEE_USD, SERVICE_CONFIG } from "../src/config/services.js";
import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/config/env.js";
import { cacheKey, TtlCache } from "../src/lib/cache.js";
import { CostGuard } from "../src/lib/costGuard.js";
import { redact } from "../src/lib/log.js";
import { Store } from "../src/lib/store.js";
import { createDataForSeoClient, DataForSeoError } from "../src/dataforseo/client.js";
import { keywordMetrics } from "../src/services/keywordMetrics.js";
import { fakeFetch, fixture } from "./helpers.js";

const CREDS = { DATAFORSEO_LOGIN: "l", DATAFORSEO_PASSWORD: "p" };

describe("env guards", () => {
  it("accepts .env.example as-is (empty optional values)", () => {
    const example = Object.fromEntries(
      readFileSync(new URL("../.env.example", import.meta.url), "utf8")
        .split("\n")
        .filter((l) => /^[A-Z_]+=/.test(l))
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    );
    expect(() => loadEnv(example)).not.toThrow();
  });
  it("treats an empty SITE_NAME as the default", () => {
    expect(loadEnv({ SITE_NAME: "" }).SITE_NAME).toBe("Agent Data API");
  });
  it("defaults to sandbox data without payments", () => {
    const env = loadEnv({});
    expect(env.DATAFORSEO_MODE).toBe("sandbox");
    expect(env.PAYMENT_MODE).toBe("off");
  });
  it("refuses live data without payments", () => {
    expect(() => loadEnv({ DATAFORSEO_MODE: "live" })).toThrow(/PAYMENT_MODE=off is only allowed/);
  });
  it("refuses production without payments", () => {
    expect(() => loadEnv({ NODE_ENV: "production", ADMIN_PASSWORD: "x".repeat(20) })).toThrow(/not allowed in production/);
  });
  it("requires a pay-to address and DataForSEO credentials when payments are on", () => {
    expect(() => loadEnv({ PAYMENT_MODE: "testnet" })).toThrow(/PAY_TO_ADDRESS/);
    expect(() => loadEnv({ PAYMENT_MODE: "testnet", PAY_TO_ADDRESS: "0x" + "1".repeat(40) })).toThrow(/credentials are required/);
  });
  it("requires explicit opt-in for live data on testnet", () => {
    const base = { PAYMENT_MODE: "testnet", PAY_TO_ADDRESS: "0x" + "1".repeat(40), DATAFORSEO_MODE: "live", ...CREDS };
    expect(() => loadEnv(base)).toThrow(/ALLOW_LIVE_DATA_ON_TESTNET/);
    expect(loadEnv({ ...base, ALLOW_LIVE_DATA_ON_TESTNET: "true" }).ALLOW_LIVE_DATA_ON_TESTNET).toBe(true);
  });
  it("refuses mainnet with sandbox data", () => {
    expect(() => loadEnv({ PAYMENT_MODE: "mainnet", PAY_TO_ADDRESS: "0x" + "1".repeat(40), ...CREDS })).toThrow(/mainnet payments must serve live data/);
  });
  it("does not echo secret values in errors", () => {
    try {
      loadEnv({ DATAFORSEO_MODE: "live", DATAFORSEO_PASSWORD: "super-secret-value" });
    } catch (e) {
      expect(String(e)).not.toContain("super-secret-value");
    }
  });
});

describe("cache", () => {
  it("keys are order-independent and expire", () => {
    let now = 0;
    const c = new TtlCache<number>(10, () => now);
    expect(cacheKey("s", { a: 1, b: 2 })).toBe(cacheKey("s", { b: 2, a: 1 }));
    expect(cacheKey("s", { a: 1 })).not.toBe(cacheKey("t", { a: 1 }));
    c.set("k", 1, 10);
    expect(c.get("k")).toBe(1);
    now = 10_001;
    expect(c.get("k")).toBeUndefined();
  });
  it("evicts the oldest entry when full", () => {
    const c = new TtlCache<number>(2);
    c.set("a", 1, 60);
    c.set("b", 2, 60);
    c.set("c", 3, 60);
    expect(c.get("a")).toBeUndefined();
    expect(c.get("c")).toBe(3);
  });
});

describe("log redaction", () => {
  it("redacts secret-looking keys", () => {
    expect(redact({ password: "x", nested: { apiKey: "y", ok: 1 }, authorization: "Basic z" })).toEqual({
      password: "[redacted]",
      nested: { apiKey: "[redacted]", ok: 1 },
      authorization: "[redacted]",
    });
  });
});

describe("keyword-metrics input", () => {
  const parse = (b: unknown) => keywordMetrics.inputSchema.safeParse(b);
  it("normalizes, dedupes and applies defaults", () => {
    const r = parse({ keywords: ["  Running Shoes ", "running shoes"] });
    expect(r.success && r.data).toEqual({ keywords: ["running shoes"], location_code: 2840, language_code: "en" });
  });
  it("accepts up to 1000 keywords and rejects more", () => {
    expect(parse({ keywords: Array.from({ length: 1000 }, (_, i) => `kw ${i}`) }).success).toBe(true);
    expect(parse({ keywords: Array.from({ length: 1001 }, (_, i) => `kw ${i}`) }).success).toBe(false);
  });
  it("rejects unknown fields, empty lists and odd characters", () => {
    expect(parse({ keywords: ["a"], limit: 1000 }).success).toBe(false);
    expect(parse({ keywords: [] }).success).toBe(false);
    expect(parse({ keywords: ["<script>"] }).success).toBe(false);
    expect(parse({ keywords: ["a\u0000b"] }).success).toBe(false);
    expect(parse({ keywords: ["x".repeat(81)] }).success).toBe(false);
    expect(parse({ keywords: ["a"], language_code: "en; drop" }).success).toBe(false);
    expect(parse({ keywords: ["a"], location_code: "2840" }).success).toBe(false);
  });
  it("builds exactly one upstream task", () => {
    const body = keywordMetrics.buildRequest({ keywords: ["a"], location_code: 2276, language_code: "de" });
    expect(body).toEqual([{ keywords: ["a"], location_code: 2276, language_code: "de" }]);
  });
  it("maps DataForSEO results and keeps nulls as null", () => {
    const task = fixture("google-ads-search-volume.json").tasks[0];
    const out = keywordMetrics.mapResult(task, { keywords: ["running shoes"], location_code: 2840, language_code: "en" });
    expect(out.keywords).toHaveLength(2);
    expect(out.keywords[0]).toMatchObject({ keyword: "running shoes", search_volume: 1000, competition: "HIGH", competition_index: 100, cpc: 1.25 });
    expect(out.keywords[0]!.monthly_searches).toEqual([
      { year: 2026, month: 9, search_volume: 1100 },
      { year: 2026, month: 8, search_volume: 900 },
    ]);
    expect(out.keywords[1]).toMatchObject({ search_volume: null, cpc: null, monthly_searches: null });
  });
});

describe("DataForSEO client", () => {
  const make = (f: typeof fetch, mode: "sandbox" | "live" = "sandbox") =>
    createDataForSeoClient({ mode, login: "l", password: "p", timeoutMs: 200, fetchImpl: f });

  it("uses the sandbox host, basic auth and returns task + cost", async () => {
    const ff = fakeFetch(fixture("google-ads-search-volume.json"));
    const r = await make(ff.impl).post("/v3/keywords_data/google_ads/search_volume/live", [{}]);
    expect(ff.calls[0]!.url).toBe("https://sandbox.dataforseo.com/v3/keywords_data/google_ads/search_volume/live");
    expect((ff.calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Basic " + Buffer.from("l:p").toString("base64"));
    expect(r.costUsd).toBe(0.09);
    expect(r.task.result).toHaveLength(2);
  });
  it("uses the live host in live mode", async () => {
    const ff = fakeFetch(fixture("google-ads-search-volume.json"));
    await make(ff.impl, "live").post("/v3/x/live", [{}]);
    expect(ff.calls[0]!.url.startsWith("https://api.dataforseo.com/")).toBe(true);
  });
  it("surfaces top-level and task-level error codes with cost", async () => {
    const top = fakeFetch({ status_code: 40210, status_message: "Insufficient funds", cost: 0, tasks: [] });
    await expect(make(top.impl).post("/v3/x", [{}])).rejects.toMatchObject({ code: 40210 });
    const task = fakeFetch({ status_code: 20000, cost: 0, tasks: [{ status_code: 40501, status_message: "Invalid Field", cost: 0 }] });
    await expect(make(task.impl).post("/v3/x", [{}])).rejects.toMatchObject({ code: 40501 });
  });
  it("times out without retrying", async () => {
    const ff = fakeFetch(fixture("google-ads-search-volume.json"), { delayMs: 50 });
    const slow = (async (u: string, init: RequestInit) => {
      return await new Promise<Response>((resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("t"), { name: "TimeoutError" })));
        void ff.impl(u, init).then((r) => setTimeout(() => resolve(r), 1000));
      });
    }) as unknown as typeof fetch;
    await expect(make(slow).post("/v3/x", [{}])).rejects.toMatchObject({ code: "timeout" });
    expect(ff.calls).toHaveLength(1);
  });
  it("refuses to call without credentials or with a malformed endpoint", async () => {
    const ff = fakeFetch({});
    const noCreds = createDataForSeoClient({ mode: "sandbox", login: "", password: "", timeoutMs: 100, fetchImpl: ff.impl });
    await expect(noCreds.post("/v3/x", [])).rejects.toMatchObject({ code: "no_credentials" });
    await expect(make(ff.impl).post("https://evil.example/v3", [])).rejects.toBeInstanceOf(DataForSeoError);
    await expect(make(ff.impl).post("/v3/../../x", [])).rejects.toMatchObject({ code: "bad_endpoint" });
    expect(ff.calls).toHaveLength(0);
  });
});

describe("cost guard", () => {
  it("enforces ceiling, daily budget incl. reservations, and per-minute rate", () => {
    let now = 1_000_000;
    const store = new Store(":memory:");
    const g = new CostGuard(store, { dailyUsd: 0.2, monthlyUsd: 100, countSpend: true }, () => now);
    expect(g.check("s", 0.2, 0.1, 10)?.code).toBe("cost_ceiling");
    const a = g.reserve("s", 0.09, 0.1, 10);
    const b = g.reserve("s", 0.09, 0.1, 10);
    expect("release" in a && "release" in b).toBe(true);
    expect(g.check("s", 0.09, 0.1, 10)?.code).toBe("daily_budget");
    if ("release" in a) a.release();
    expect(g.check("s", 0.09, 0.1, 10)).toBeNull();
    // rate: 2 slots already used in this minute
    expect(g.check("s", 0, 0.1, 2)?.code).toBe("upstream_busy");
    now += 60_001;
    expect(g.check("s", 0, 0.1, 2)).toBeNull();
  });
  it("counts recorded live spend against the daily limit, ignores sandbox rows", () => {
    const store = new Store(":memory:");
    const g = new CostGuard(store, { dailyUsd: 0.1, monthlyUsd: 100, countSpend: true });
    store.claim({ id: "1", service_id: "s", data_source: "sandbox", price_usdc: 0, payment_key: null, network: null, payer: null, input_hash: null, input_json: null, result_token_hash: null });
    store.fail("1", "x", 5);
    expect(g.check("s", 0.09, 0.1, 10)).toBeNull();
    store.claim({ id: "2", service_id: "s", data_source: "live", price_usdc: 0, payment_key: null, network: null, payer: null, input_hash: null, input_json: null, result_token_hash: null });
    store.fail("2", "x", 0.05);
    expect(g.check("s", 0.09, 0.1, 10)?.code).toBe("daily_budget");
  });
});

describe("store", () => {
  it("migrates a database created by the phase-1 schema", () => {
    const path = join(mkdtempSync(join(tmpdir(), "store-")), "old.db");
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE requests (id TEXT PRIMARY KEY, service_id TEXT NOT NULL, created_at TEXT NOT NULL, status TEXT NOT NULL,
      data_source TEXT NOT NULL, price_usdc REAL NOT NULL DEFAULT 0, payment_key TEXT UNIQUE, network TEXT, payer TEXT, tx_hash TEXT,
      upstream_cost_usd REAL NOT NULL DEFAULT 0, cache_hit INTEGER NOT NULL DEFAULT 0, result_token_hash TEXT, result_json TEXT, error_code TEXT)`);
    old.exec(`INSERT INTO requests (id, service_id, created_at, status, data_source) VALUES ('old', 's', '2026-10-01', 'completed', 'sandbox')`);
    old.close();
    const s = new Store(path);
    expect(s.claim({ id: "new", service_id: "s", data_source: "sandbox", price_usdc: 0, payment_key: null, network: null, payer: null, input_hash: "h", input_json: "{}", result_token_hash: "t" })).toBe(true);
    expect(s.get("old")?.retries).toBe(0);
    expect(s.get("new")?.input_json).toBe("{}");
    s.close();
  });

  it("rejects a second claim of the same payment key", () => {
    const s = new Store(":memory:");
    const row = { service_id: "s", data_source: "live" as const, price_usdc: 0.05, payment_key: "pk", network: "eip155:84532", payer: null, input_hash: "h", input_json: null, result_token_hash: null };
    expect(s.claim({ id: "a", ...row })).toBe(true);
    expect(s.claim({ id: "b", ...row })).toBe(false);
  });
});

describe("pricing", () => {
  it("every service is priced below its market reference and above worst-case cost + facilitator fee", () => {
    for (const c of Object.values(SERVICE_CONFIG)) {
      expect(Number(c.priceUsdc), c.id).toBeGreaterThan(c.worstCaseUsd + FACILITATOR_FEE_USD);
      if (c.referencePriceUsdc) expect(Number(c.priceUsdc), c.id).toBeLessThan(Number(c.referencePriceUsdc));
      expect(c.worstCaseUsd, c.id).toBeLessThanOrEqual(c.maxUpstreamCostUsd);
      expect(c.priceUsdc, c.id).toMatch(/^\d+\.\d{1,6}$/); // USDC has 6 decimals
    }
  });
  it("keyword-metrics estimate at max input stays within the configured worst case", () => {
    const max = { keywords: Array.from({ length: 1000 }, (_, i) => `kw ${i}`), location_code: 2840, language_code: "en" };
    expect(keywordMetrics.estimateCostUsd(max)).toBeLessThanOrEqual(SERVICE_CONFIG["keyword-metrics"]!.worstCaseUsd);
  });
});
