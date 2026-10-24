/**
 * Regression tests for the findings of the independent security review (2026-10-21).
 * F = confirmed finding, S = suspected finding. Each test pins the fixed behaviour.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadEnv } from "../src/config/env.js";
import { createFacilitator, checkPayment, toAtomic, REPLAY_WINDOW_MS, MAX_INFLIGHT_PER_CLIENT } from "../src/payments/x402.js";
import { Store } from "../src/lib/store.js";
import { backupLedger } from "../src/lib/backup.js";
import { buildTestApp, fakeFetch, fixture, PAY_TO } from "./helpers.js";
import { buyer, fakeFacilitator, post, routedUpstream, start, upstream, type Event } from "./x402helpers.js";
import type { PaymentPayload } from "@x402/core/types";

const ROUTE = "/api/v1/keyword-metrics";
const BODY = { keywords: ["running shoes"], location_code: 2840, language_code: "en" };
const PRICE = "0.12";

describe("keyword suggestions payment boundary", () => {
  it("rejects multiple seed phrases before payment instead of silently ignoring terms", async () => {
    const events: Event[] = [];
    const fac = fakeFacilitator(events);
    const { app, store } = buildTestApp({ fetchImpl: routedUpstream(events).impl, facilitator: fac });
    const base = await start(app);
    const { pay } = buyer();
    const res = await pay(base + "/api/v1/keyword-ideas", post({ keywords: ["running shoes", "seo tools"] }));
    expect(res.status).toBe(400);
    expect(res.headers.get("payment-required")).toBeNull();
    expect(events).toEqual([]);
    expect(fac.settles()).toBe(0);
    expect(store.stats("day").perService).toEqual([]);
  });
});

describe("backup payload retention", () => {
  it("restores the ledger and removes expired payloads from older snapshots without changing the live database", () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-backup-"));
    const database = join(directory, "live.db");
    const backups = join(directory, "backups");
    const store = new Store(database);
    try {
      store.db.prepare(`INSERT INTO requests
        (id, service_id, created_at, status, data_source, input_json, result_json, tx_hash, price_usdc)
        VALUES (?, 'keyword-ideas', ?, 'completed', 'sandbox', ?, ?, 'retained-payment', 0.025)`)
        .run("paid-call", "2026-09-23T00:00:00.000Z", '"private-keyword-marker"', '"private-result-marker"');
      const first = backupLedger(database, backups, 30, new Date("2026-10-22T01:00:00Z"));
      const restored = new Store(join(backups, first));
      expect(restored.db.prepare("SELECT input_json, tx_hash FROM requests").get())
        .toEqual(expect.objectContaining({ input_json: '"private-keyword-marker"', tx_hash: "retained-payment" }));
      restored.db.close();
      backupLedger(database, backups, 30, new Date("2026-10-24T01:00:00Z"));
      const expired = new Store(join(backups, first));
      expect(expired.db.prepare("SELECT input_json, result_json, tx_hash, price_usdc FROM requests").get())
        .toEqual(expect.objectContaining({ input_json: null, result_json: null, tx_hash: "retained-payment", price_usdc: 0.025 }));
      expired.db.close();
      expect(readFileSync(join(backups, first)).includes(Buffer.from("private-keyword-marker"))).toBe(false);
      expect(statSync(join(backups, first)).mode & 0o777).toBe(0o600);
      expect(statSync(backups).mode & 0o777).toBe(0o700);
      expect(store.db.prepare("SELECT input_json FROM requests").get()?.input_json).toBe('"private-keyword-marker"');
    } finally {
      store.db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

/** A genuinely signed payment captured from the real buyer client (for tampering tests). */
async function signedPayment(base: string): Promise<{ header: string; payload: PaymentPayload }> {
  const client = new x402Client();
  registerExactEvmScheme(client, { signer: privateKeyToAccount(generatePrivateKey()) });
  let header = "";
  const spy = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const sig = req.headers.get("payment-signature");
    if (sig) header = sig;
    return fetch(req);
  }) as typeof fetch;
  await wrapFetchWithPayment(spy, client)(base + ROUTE, post(BODY));
  return { header, payload: JSON.parse(Buffer.from(header, "base64").toString("utf8")) };
}

describe("F1: a client that disconnects during settlement must not lose a settled payment", () => {
  it("keeps the ledger row, completes the work and lets the same payment fetch the stored result", async () => {
    const events: Event[] = [];
    const controller = new AbortController();
    const fac = fakeFacilitator(events, { settleDelayMs: 400 });
    const settle = fac.settle.bind(fac);
    fac.settle = async (...args) => {
      const pending = settle(...args);
      controller.abort(); // Disconnect exactly while settlement is in flight.
      return pending;
    };
    const { app, store } = buildTestApp({ fetchImpl: routedUpstream(events).impl, facilitator: fac });
    const base = await start(app);
    const client = new x402Client();
    registerExactEvmScheme(client, { signer: privateKeyToAccount(generatePrivateKey()) });
    let header = "";
    const spy = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      header = req.headers.get("payment-signature") ?? header;
      return fetch(req, { signal: controller.signal });
    }) as typeof fetch;
    const aborted = await wrapFetchWithPayment(spy, client)(base + ROUTE, post(BODY)).then(
      () => "completed",
      () => "aborted",
    );
    expect(aborted).toBe("aborted");

    // The server keeps working: settlement finishes, data is fetched once, the row is complete.
    for (let i = 0; i < 50 && !events.includes("upstream"); i++) await new Promise((r) => setTimeout(r, 40));
    await new Promise((r) => setTimeout(r, 100));
    expect(events).toEqual(["settle", "upstream"]);
    const stats = store.stats("day").perService as { paid: number; completed: number }[];
    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({ paid: 1, completed: 1 });
    expect(store.needsAttention()).toHaveLength(0);

    // The payer comes back with the same payment and gets what was paid for, without a second settlement or upstream call.
    const again = await fetch(base + ROUTE, post(BODY, { "payment-signature": header }));
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ replayed: true, service: "keyword-metrics" });
    expect(fac.settles()).toBe(1);
    expect(events.filter((e) => e === "upstream")).toHaveLength(1);
  });
});

describe("F2: replaying a payment never hands out or rotates the result token, and only for a limited time", () => {
  it("returns data without a token, keeps the original token valid, and rejects a different body", async () => {
    const events: Event[] = [];
    const { app } = buildTestApp({ fetchImpl: routedUpstream(events).impl, facilitator: fakeFacilitator(events) });
    const base = await start(app);
    const client = new x402Client();
    registerExactEvmScheme(client, { signer: privateKeyToAccount(generatePrivateKey()) });
    let header = "";
    const spy = (async (i: RequestInfo | URL, init?: RequestInit) => {
      const r = new Request(i, init);
      header = r.headers.get("payment-signature") ?? header;
      return fetch(r);
    }) as typeof fetch;
    const first = await (await wrapFetchWithPayment(spy, client)(base + ROUTE, post(BODY))).json();

    const replay = await (await fetch(base + ROUTE, post(BODY, { "payment-signature": header }))).json();
    expect(replay.replayed).toBe(true);
    expect(replay.result_token).toBeUndefined();
    // The original payer's token still works after any number of replays by anybody.
    const fetched = await fetch(`${base}/api/v1/results/${first.request_id}`, { headers: { authorization: `Bearer ${first.result_token}` } });
    expect(fetched.status).toBe(200);

    const other = await fetch(base + ROUTE, post({ ...BODY, keywords: ["something else"] }, { "payment-signature": header }));
    expect(other.status).toBe(409);
    expect(JSON.stringify(await other.json())).not.toContain(first.request_id); // no identifiers for strangers
  });

  it("stops returning data after the replay window", async () => {
    const events: Event[] = [];
    const { app, store } = buildTestApp({ fetchImpl: routedUpstream(events).impl, facilitator: fakeFacilitator(events) });
    const base = await start(app);
    const { payload, header } = await signedPayment(base).then(async () => {
      // pay once for real, keep the signature
      const client = new x402Client();
      registerExactEvmScheme(client, { signer: privateKeyToAccount(generatePrivateKey()) });
      let h = "";
      const spy = (async (i: RequestInfo | URL, init?: RequestInit) => {
        const r = new Request(i, init);
        h = r.headers.get("payment-signature") ?? h;
        return fetch(r);
      }) as typeof fetch;
      await wrapFetchWithPayment(spy, client)(base + ROUTE, post(BODY));
      return { header: h, payload: null };
    });
    void payload;
    const old = new Date(Date.now() - REPLAY_WINDOW_MS - 60_000).toISOString();
    store.db.prepare(`UPDATE requests SET created_at = ?`).run(old);
    const res = await fetch(base + ROUTE, post(BODY, { "payment-signature": header }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("payment_already_used");
  });

  it("a replay of a paid request that failed at the data provider performs the one free retry", async () => {
    const events: Event[] = [];
    const failing = { status_code: 50000, status_message: "Internal Error.", cost: 0, tasks: [] };
    const { app } = buildTestApp({ fetchImpl: upstream(events, [failing, fixture("google-ads-search-volume.json")]).impl, facilitator: fakeFacilitator(events) });
    const base = await start(app);
    const client = new x402Client();
    registerExactEvmScheme(client, { signer: privateKeyToAccount(generatePrivateKey()) });
    let header = "";
    const spy = (async (i: RequestInfo | URL, init?: RequestInit) => {
      const r = new Request(i, init);
      header = r.headers.get("payment-signature") ?? header;
      return fetch(r);
    }) as typeof fetch;
    const failed = await wrapFetchWithPayment(spy, client)(base + ROUTE, post(BODY));
    expect(failed.status).toBe(502);
    const replay = await fetch(base + ROUTE, post(BODY, { "payment-signature": header }));
    expect(replay.status).toBe(200);
    const body = await replay.json();
    expect(body.replayed).toBe(true);
    expect(body.result.keywords.length).toBeGreaterThan(0);
    expect(body.result_token).toBeUndefined();
    const third = await fetch(base + ROUTE, post(BODY, { "payment-signature": header }));
    expect(third.status).toBe(200); // now completed: stored result, no further upstream call
    expect(events.filter((e) => e === "upstream")).toHaveLength(2);
  });
});

describe("F3: invalid payments are rejected locally and cannot hold budget, rate slots or facilitator calls", () => {
  it("accepts a genuine payment and rejects every kind of tampered or garbage payment before the facilitator is called", async () => {
    const events: Event[] = [];
    const { app } = buildTestApp({ fetchImpl: routedUpstream(events).impl, facilitator: fakeFacilitator(events) });
    const base = await start(app);
    const { payload } = await signedPayment(base);
    events.length = 0; // the capture above hit the (fake) facilitator once
    const expect_ = { mode: "testnet" as const, amount: toAtomic(PRICE), payTo: PAY_TO };
    expect(await checkPayment(payload, expect_)).toBeNull();

    const clone = () => structuredClone(payload) as any;
    const cases: [string, (p: any) => void][] = [
      ["wrong version", (p) => (p.x402Version = 1)],
      ["wrong network", (p) => (p.accepted.network = "eip155:8453")],
      ["wrong amount in accepted", (p) => (p.accepted.amount = "1")],
      ["wrong amount in authorization", (p) => (p.payload.authorization.value = "1")],
      ["wrong payTo", (p) => (p.payload.authorization.to = "0x" + "1".repeat(40))],
      ["wrong asset", (p) => (p.accepted.asset = "0x" + "2".repeat(40))],
      ["expired", (p) => (p.payload.authorization.validBefore = "1")],
      ["not yet valid", (p) => (p.payload.authorization.validAfter = String(Math.floor(Date.now() / 1000) + 3600))],
      ["bad nonce", (p) => (p.payload.authorization.nonce = "0x1234")],
      ["non-string from", (p) => (p.payload.authorization.from = 5)],
      ["object nonce", (p) => (p.payload.authorization.nonce = { a: 1 })],
      ["garbage signature", (p) => (p.payload.signature = "0x" + "11".repeat(65))],
      ["signature of someone else", (p) => (p.payload.authorization.from = "0x" + "3".repeat(40))],
      ["no authorization", (p) => delete p.payload.authorization],
      ["tampered nonce", (p) => (p.payload.authorization.nonce = "0x" + "ab".repeat(32))],
    ];
    for (const [name, mutate] of cases) {
      const p = clone();
      mutate(p);
      expect(await checkPayment(p, expect_), name).toEqual(expect.any(String));
    }

    // Over HTTP: 400, no settle, no upstream, no row, no leaked reservation.
    for (const [name, mutate] of cases) {
      const p = clone();
      mutate(p);
      const res = await fetch(base + ROUTE, post(BODY, { "payment-signature": Buffer.from(JSON.stringify(p)).toString("base64") }));
      expect(res.status, name).toBe(400);
      expect((await res.json()).error, name).toBe("invalid_payment");
    }
    expect(events).toEqual([]);
  });

  it("garbage payments do not use up the upstream rate slots of real buyers", async () => {
    const events: Event[] = [];
    const { app } = buildTestApp({ fetchImpl: routedUpstream(events).impl, facilitator: fakeFacilitator(events, { settleDelayMs: 300 }), countSpend: true });
    const base = await start(app);
    const { payload } = await signedPayment(base);
    events.length = 0;
    const garbage = (i: number) => {
      const p = structuredClone(payload) as any;
      p.payload.authorization.nonce = "0x" + i.toString(16).padStart(64, "0");
      return fetch(base + ROUTE, post(BODY, { "payment-signature": Buffer.from(JSON.stringify(p)).toString("base64") }));
    };
    const flood = await Promise.all(Array.from({ length: 30 }, (_, i) => garbage(i)));
    expect(flood.every((r) => r.status === 400)).toBe(true);
    const { pay } = buyer();
    expect((await pay(base + ROUTE, post(BODY))).status).toBe(200); // a real buyer is not locked out (limit is 10/min)
  });

  it("caps payments in flight per client address", async () => {
    const events: Event[] = [];
    const fac = fakeFacilitator(events, { settleDelayMs: 600 });
    const { app } = buildTestApp({ fetchImpl: routedUpstream(events).impl, facilitator: fac });
    const base = await start(app);
    const results = await Promise.all(Array.from({ length: MAX_INFLIGHT_PER_CLIENT + 4 }, () => buyer().pay(base + ROUTE, post({ ...BODY, keywords: [`kw ${Math.random()}`] }))));
    const codes = results.map((r) => r.status).sort();
    expect(codes.filter((c) => c === 200).length).toBe(MAX_INFLIGHT_PER_CLIENT);
    expect(codes.filter((c) => c === 429).length).toBe(4);
    expect(fac.settles()).toBe(MAX_INFLIGHT_PER_CLIENT);
    // Afterwards the slots are free again.
    expect((await buyer().pay(base + ROUTE, post({ ...BODY, keywords: ["later"] }))).status).toBe(200);
  });

  it("toAtomic converts USDC prices exactly", () => {
    expect(toAtomic("0.12")).toBe("120000");
    expect(toAtomic("0.025")).toBe("25000");
    expect(toAtomic("1")).toBe("1000000");
    expect(toAtomic("0.000001")).toBe("1");
  });
});

describe("F5: MCP batches", () => {
  it("rejects JSON-RPC batch arrays", async () => {
    const { app } = buildTestApp({ fetchImpl: routedUpstream([]).impl, facilitator: fakeFacilitator([]) });
    const base = await start(app);
    const res = await fetch(base + "/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "tools/call", params: { name: "keyword_metrics", arguments: { keywords: ["a"] } } }))),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(-32600);
    // A normal single message still works.
    const c = new Client({ name: "t", version: "1" });
    await c.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp")));
    expect((await c.listTools()).tools.length).toBeGreaterThan(5);
    await c.close();
  });
});

describe("F7: client mistakes are 4xx, never 500", () => {
  it("bad URL encoding, unsupported content-encoding, malformed payment fields", async () => {
    const events: Event[] = [];
    const { app } = buildTestApp({ fetchImpl: routedUpstream(events).impl, facilitator: fakeFacilitator(events) });
    const base = await start(app);
    expect((await fetch(`${base}/api/v1/results/%ZZ`)).status).toBe(400);
    const enc = await fetch(base + ROUTE, { method: "POST", headers: { "content-type": "application/json", "content-encoding": "br" }, body: "x" });
    expect(enc.status).toBeGreaterThanOrEqual(400); // was 500 before the fix
    expect(enc.status).toBeLessThan(500);
    for (const bad of [{ from: 5 }, { nonce: { a: 1 } }, {}]) {
      const p = { x402Version: 2, accepted: { scheme: "exact" }, payload: { authorization: bad, signature: 1 } };
      const res = await fetch(base + ROUTE, post(BODY, { "payment-signature": Buffer.from(JSON.stringify(p)).toString("base64") }));
      expect(res.status).toBe(400);
    }
    expect(events).toEqual([]);
  });
});

describe("F8: mainnet facilitator and configuration safety", () => {
  const MAINNET_OK = {
    NODE_ENV: "production",
    PAYMENT_MODE: "mainnet",
    DATAFORSEO_MODE: "live",
    DATAFORSEO_LOGIN: "l",
    DATAFORSEO_PASSWORD: "p",
    PAY_TO_ADDRESS: PAY_TO,
    PUBLIC_BASE_URL: "https://agent.example.com",
    ADMIN_PASSWORD: "x".repeat(20),
    CDP_API_KEY_ID: "id",
    CDP_API_KEY_SECRET: "secret",
    TRUST_PROXY: "1",
  };

  it("a valid mainnet configuration loads; each safety rule is enforced", () => {
    expect(loadEnv(MAINNET_OK).PAYMENT_MODE).toBe("mainnet");
    expect(() => loadEnv({ ...MAINNET_OK, NODE_ENV: "development" })).toThrow(/NODE_ENV=production/);
    expect(() => loadEnv({ ...MAINNET_OK, PUBLIC_BASE_URL: "http://agent.example.com" })).toThrow(/https/);
    expect(() => loadEnv({ ...MAINNET_OK, CDP_API_KEY_SECRET: "" })).toThrow(/CDP_API_KEY/);
    expect(() => loadEnv({ ...MAINNET_OK, CDP_API_KEY_ID: "" })).toThrow(/CDP_API_KEY/);
    expect(() => loadEnv({ ...MAINNET_OK, ADMIN_PASSWORD: "short" })).toThrow(/ADMIN_PASSWORD/);
    expect(() => loadEnv({ ...MAINNET_OK, NODE_ENV: "production", PUBLIC_BASE_URL: "http://localhost:3000" })).toThrow(/https/);
    // Second review round
    expect(() => loadEnv({ ...MAINNET_OK, FACILITATOR_URL: "http://facilitator.example.net" })).toThrow(/https/);
    expect(() => loadEnv({ ...MAINNET_OK, FACILITATOR_URL: "https://facilitator.example.net", CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "" }).FACILITATOR_URL).not.toThrow;
    expect(loadEnv({ ...MAINNET_OK, FACILITATOR_URL: "https://facilitator.example.net", CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "" }).FACILITATOR_URL).toBe("https://facilitator.example.net");
    expect(() => loadEnv({ ...MAINNET_OK, FACILITATOR_URL: "https://www.coinbase.com/x" })).toThrow(/api\.cdp\.coinbase\.com/);
    expect(loadEnv({ ...MAINNET_OK, FACILITATOR_URL: "https://api.cdp.coinbase.com/platform/v2/x402" }).PAYMENT_MODE).toBe("mainnet");
    expect(() => loadEnv({ ...MAINNET_OK, PAY_TO_ADDRESS: "0x" + "0".repeat(40) })).toThrow(/zero address/);
    expect(() => loadEnv({ ...MAINNET_OK, TRUST_PROXY: "0" })).toThrow(/TRUST_PROXY=1/);
    expect(() => loadEnv({ ...MAINNET_OK, FACILITATOR_URL: "not a url" })).toThrow(/Invalid configuration/);
  });

  it("the pay-to address checksum is validated when the address is mixed case", () => {
    const base = { ...MAINNET_OK };
    const good = "0xe6a2dDdB4C395A393e6035D7194119f62C969fAD"; // EIP-55 checksummed form of the project's address
    expect(loadEnv({ ...base, PAY_TO_ADDRESS: good }).PAY_TO_ADDRESS).toBe(good);
    expect(loadEnv({ ...base, PAY_TO_ADDRESS: good.toLowerCase() }).PAY_TO_ADDRESS).toBe(good.toLowerCase());
    const typo = good.slice(0, 10) + (good[10] === "A" ? "a" : "A") + good.slice(11); // flips the case of one letter
    expect(() => loadEnv({ ...base, PAY_TO_ADDRESS: typo })).toThrow(/checksum/);
  });

  it("builds an authenticated Coinbase facilitator for mainnet and refuses unsafe combinations", () => {
    const cdp = createFacilitator({ PAYMENT_MODE: "mainnet", FACILITATOR_URL: "", CDP_API_KEY_ID: "id", CDP_API_KEY_SECRET: "secret" }) as unknown as { url: string };
    expect(cdp.url).toContain("api.cdp.coinbase.com");
    expect(() => createFacilitator({ PAYMENT_MODE: "mainnet", FACILITATOR_URL: "", CDP_API_KEY_ID: "", CDP_API_KEY_SECRET: "" })).toThrow(/CDP_API_KEY/);
    expect(() => createFacilitator({ PAYMENT_MODE: "mainnet", FACILITATOR_URL: "https://x402.org/facilitator" })).toThrow(/testnet-only/);
    const test = createFacilitator({ PAYMENT_MODE: "testnet", FACILITATOR_URL: "" }) as unknown as { url: string };
    expect(test.url).toBe("https://x402.org/facilitator");
    const custom = createFacilitator({ PAYMENT_MODE: "mainnet", FACILITATOR_URL: "https://facilitator.example.net" }) as unknown as { url: string };
    expect(custom.url).toBe("https://facilitator.example.net");
  });
});

describe("F9: cache headers, methods, preflight privacy", () => {
  it("API and MCP responses are no-store, wrong methods are 405 and preflight does not reveal cache state", async () => {
    const { app } = buildTestApp({ fetchImpl: routedUpstream([]).impl, facilitator: fakeFacilitator([]) });
    const base = await start(app);
    for (const path of ["/api/v1/services", "/mcp"]) {
      const res = await fetch(base + path, path === "/mcp" ? { method: "POST", body: "{}", headers: { "content-type": "application/json" } } : {});
      expect(res.headers.get("cache-control"), path).toBe("no-store");
    }
    const get = await fetch(base + ROUTE);
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
    const pre = await (await fetch(base + "/api/v1/preflight/keyword-metrics", post(BODY))).json();
    expect(pre.cached).toBeUndefined();
  });
});

describe("S1/S4/S7", () => {
  it("S1: requests interrupted by a restart are finished off and kept for manual review", () => {
    const store = new Store(":memory:");
    const row = (id: string, key: string | null) => ({ id, service_id: "s", data_source: "live" as const, price_usdc: 0.1, payment_key: key, network: "eip155:8453", payer: "0xabc", input_hash: "h", input_json: "{}", result_token_hash: "t" });
    store.claim(row("settled", "k1"));
    store.setSettled("settled", "0xtx", "0xabc");
    store.claim(row("unsettled", "k2"));
    store.claim(row("sandbox", null));
    expect(store.recoverAfterRestart()).toEqual({ settled: 1, unsettled: 1 });
    expect(store.get("settled")).toMatchObject({ status: "failed", error_code: "interrupted" });
    expect(store.get("unsettled")).toMatchObject({ status: "failed", error_code: "interrupted_unsettled" });
    expect(store.get("sandbox")).toBeUndefined();
    expect(store.needsAttention().map((r) => r.id).sort()).toEqual(["settled", "unsettled"]);
    expect(store.beginRetry("settled")).toBe(true); // the payer can still use the free retry
    expect(store.beginRetry("unsettled")).toBe(false); // nothing is known to be settled
  });

  it("S4: an upstream timeout is booked at the worst-case estimate (the provider may still bill it)", async () => {
    const timeoutFetch = (async (_u: unknown, init?: RequestInit) =>
      new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("t"), { name: "TimeoutError" }))))) as unknown as typeof fetch;
    const { app, store } = buildTestApp({ fetchImpl: timeoutFetch, env: { DATAFORSEO_TIMEOUT_MS: "1000" } });
    const base = await start(app);
    const res = await fetch(base + ROUTE, post(BODY));
    expect(res.status).toBe(504);
    const row = store.get((await res.json()).request_id)!;
    expect(row.status).toBe("failed");
    expect(row.upstream_cost_usd).toBeCloseTo(0.09);
  });

  it("S7: SERP results carry a notice that titles and descriptions are third-party text", async () => {
    const { app } = buildTestApp({ fetchImpl: fakeFetch(fixture("serp-google-organic.json")).impl });
    const res = await fetch((await start(app)) + "/api/v1/google-serp", post({ keyword: "pizza" }));
    expect((await res.json()).notice).toMatch(/third-party/);
  });
});

describe("second review round: signature kinds, caps, client keys", () => {
  it("compact 64-byte signatures are verified offline (garbage rejected); a genuine compact form is accepted", async () => {
    const events: Event[] = [];
    const { app } = buildTestApp({ fetchImpl: routedUpstream(events).impl, facilitator: fakeFacilitator(events) });
    const base = await start(app);
    const { payload } = await signedPayment(base);
    events.length = 0;
    const expect_ = { mode: "testnet" as const, amount: toAtomic(PRICE), payTo: PAY_TO };
    const garbage = structuredClone(payload) as any;
    garbage.payload.signature = "0x" + "11".repeat(64);
    expect(await checkPayment(garbage, expect_)).toEqual(expect.any(String));
    // Convert the genuine 65-byte signature to EIP-2098 compact form: it must still verify.
    const sig: string = (payload.payload as any).signature;
    const r = sig.slice(2, 66);
    const sBytes = sig.slice(66, 130);
    const v = parseInt(sig.slice(130, 132), 16);
    const yParity = v >= 27 ? v - 27 : v;
    const sCompact = (BigInt("0x" + sBytes) | (BigInt(yParity) << 255n)).toString(16).padStart(64, "0");
    const compact = structuredClone(payload) as any;
    compact.payload.signature = "0x" + r + sCompact;
    expect(await checkPayment(compact, expect_)).toBeNull();
  });

  it("signatures that cannot be verified offline (smart wallets) get a very small in-flight budget per client", async () => {
    const events: Event[] = [];
    const fac = fakeFacilitator(events, { settleDelayMs: 500 });
    const { app } = buildTestApp({ fetchImpl: routedUpstream(events).impl, facilitator: fac });
    const base = await start(app);
    const { payload } = await signedPayment(base);
    events.length = 0;
    const settledBefore = fac.settles();
    const longSig = (i: number) => {
      const p = structuredClone(payload) as any;
      p.payload.signature = "0x" + "ab".repeat(100);
      p.payload.authorization.nonce = "0x" + (i + 1).toString(16).padStart(64, "0");
      return fetch(base + ROUTE, post(BODY, { "payment-signature": Buffer.from(JSON.stringify(p)).toString("base64") }));
    };
    const res = await Promise.all([0, 1, 2, 3].map((i) => longSig(i)));
    const codes = res.map((r) => r.status);
    expect(codes.filter((c) => c === 429)).toHaveLength(3); // only 1 per client in flight
    expect(fac.settles() - settledBefore).toBe(1);
    // Normal EOA payments from the same client are unaffected.
    expect((await buyer().pay(base + ROUTE, post({ ...BODY, keywords: ["unaffected"] }))).status).toBe(200);
  });

  it("clientKey treats the hex form of an IPv4-mapped address as the same client", async () => {
    const { clientKey } = await import("../src/lib/rateLimit.js");
    expect(clientKey("::ffff:0102:0304")).toBe("1.2.3.4");
    expect(clientKey("::ffff:1.2.3.4")).toBe("1.2.3.4");
    expect(clientKey("::ffff:c000:0201")).toBe("192.0.2.1");
  });

  it("a failed settlement leaves a refund trail in the log (payer, nonce, amount, key) without secrets", async () => {
    const lines: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (c: string | Uint8Array) => (lines.push(String(c)), true);
    const { setLogLevel } = await import("../src/lib/log.js");
    setLogLevel("warn");
    try {
      const events: Event[] = [];
      const { app } = buildTestApp({ fetchImpl: routedUpstream(events).impl, facilitator: fakeFacilitator(events, { failSettle: true }) });
      const base = await start(app);
      await buyer().pay(base + ROUTE, post(BODY));
    } finally {
      (process.stderr as any).write = orig;
      setLogLevel("error");
    }
    const entry = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((e) => e?.msg === "payment settlement failed");
    expect(entry).toBeTruthy();
    expect(entry.payer).toMatch(/^0x[0-9a-f]{40}$/);
    expect(entry.nonce).toMatch(/^0x[0-9a-f]{64}$/);
    expect(entry.value).toBe(toAtomic(PRICE));
    expect(entry.payment_key).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(entry)).not.toMatch(/signature/i);
  });
});

// E2E buyer protections: offline only, no real keys, RPC calls or settlements.
import { mkdtempSync, statSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { parseOptions, PaymentGuard, selectServices, assertMode, type Service } from "../scripts/e2e-common.js";
import { createBuyerWallet } from "../scripts/buyer-wallet.js";
import type { PaymentRequirements } from "@x402/core/types";

const e2eService: Service = { id: "keyword-metrics", path: ROUTE, mcp_tool: "keyword_metrics", enabled: true, price_usdc: PRICE, example_request: BODY };
function e2eRequirements(options = parseOptions([])): PaymentRequirements {
  return { scheme: "exact", network: options.network, asset: options.asset, amount: "120000", payTo: options.payTo, maxTimeoutSeconds: 60, extra: { name: "USDC", version: "2" } };
}

describe("E2E buyer safety", () => {
  it("defaults to testnet and requires explicit mainnet opt-in plus recipient", () => {
    expect(parseOptions([]).mode).toBe("testnet");
    expect(() => parseOptions(["--network", "mainnet"])).toThrow();
    expect(() => parseOptions(["--network", "mainnet", "--confirm-mainnet"])).toThrow();
    const options = parseOptions(["https://example.com", "--network", "mainnet", "--confirm-mainnet", "--pay-to", PAY_TO]);
    expect(options.network).toBe("eip155:8453");
    expect(options.only).toBe("keyword-ideas");
    expect(options.source).toBe("live");
  });
  it.each([["--network"], ["--unknown"], ["--network", "mainnet", "--network", "testnet"], ["http://example.com"], ["https://user:password@example.com"], ["https://example.com/path"], ["--pay-to", `0x${"0".repeat(40)}`]])("rejects unsafe or ambiguous CLI input %j", (...args) => {
    expect(() => parseOptions(args)).toThrow();
  });
  it("requires both the expected payment mode and data source", () => {
    const options = parseOptions([]);
    expect(() => assertMode({ payments: "mainnet", data_source: "sandbox" }, options)).toThrow();
    expect(() => assertMode({ payments: "testnet", data_source: "live" }, options)).toThrow();
  });
  it.each([
    { network: "eip155:8453" }, { asset: PAY_TO }, { payTo: `0x${"1".repeat(40)}` }, { amount: "500001" }, { amount: "0" }, { scheme: "other" },
  ])("refuses changed requirements before authorizing: %j", (change) => {
    const guard = new PaymentGuard(parseOptions([]));
    guard.begin(e2eService);
    expect(() => guard.authorize({ ...e2eRequirements(), ...change } as PaymentRequirements)).toThrow();
  });
  it("limits total authorizations including failed calls and refuses a second signature for one call", () => {
    const guard = new PaymentGuard(parseOptions([]));
    guard.begin(e2eService);
    guard.authorize(e2eRequirements());
    expect(() => guard.authorize(e2eRequirements())).toThrow();
    for (let i = 0; i < 3; i++) { guard.begin(e2eService); guard.authorize(e2eRequirements()); }
    guard.begin(e2eService);
    expect(() => guard.authorize(e2eRequirements())).toThrow();
  });
  it("validates catalog route, network, local price and enabled selection", () => {
    const options = parseOptions([]);
    const catalog = { payments: "testnet", data_source: "sandbox", network: options.network, services: [e2eService] };
    expect(selectServices(catalog, options)).toHaveLength(1);
    for (const change of [{ path: "https://evil.example" }, { price_usdc: "0.49" }, { enabled: false }]) {
      expect(() => selectServices({ ...catalog, services: [{ ...e2eService, ...change }] }, options)).toThrow();
    }
    expect(() => selectServices({ ...catalog, network: "eip155:8453" }, options)).toThrow();
    expect(() => selectServices({ ...catalog, services: [e2eService, e2eService] }, options)).toThrow();
  });
  it.each(["testnet", "mainnet"])("runs the guard through the real SDK before signing (%s)", async (mode) => {
    const options = parseOptions(mode === "mainnet" ? ["https://example.com", "--network", "mainnet", "--confirm-mainnet", "--pay-to", PAY_TO] : []);
    const signer = privateKeyToAccount(generatePrivateKey());
    const sign = vi.spyOn(signer, "signTypedData");
    const client = new x402Client();
    registerExactEvmScheme(client, { signer, networks: [options.network] });
    const guard = new PaymentGuard(options);
    guard.begin(e2eService);
    guard.attach(client);
    const health = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ payments: options.mode, data_source: options.source })));
    try {
      const required = { x402Version: 2, resource: { url: "http://localhost:3000/api/v1/keyword-metrics", description: "", mimeType: "application/json" }, accepts: [{ ...e2eRequirements(options), payTo: `0x${"1".repeat(40)}` }] };
      await expect(client.createPaymentPayload(required)).rejects.toThrow();
      expect(sign).not.toHaveBeenCalled();
      const good = { ...required, accepts: [e2eRequirements(options)] };
      await client.createPaymentPayload(good);
      expect(sign).toHaveBeenCalledTimes(1);
      await expect(client.createPaymentPayload(good)).rejects.toThrow();
      expect(sign).toHaveBeenCalledTimes(1);
      guard.begin(e2eService);
      health.mockImplementation(async () => new Response(JSON.stringify({ payments: options.mode, data_source: options.source === "live" ? "sandbox" : "live" })));
      await expect(client.createPaymentPayload(good)).rejects.toThrow();
      expect(sign).toHaveBeenCalledTimes(1);
    } finally { health.mockRestore(); sign.mockRestore(); }
  });
  it("creates a private wallet file, refuses overwrite and dangling symlinks", () => {
    const dir = mkdtempSync(join(tmpdir(), "buyer-wallet-"));
    try {
      const file = join(dir, ".env.buyer.mainnet");
      const publicAddress = createBuyerWallet(file, "mainnet");
      expect(publicAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      const originalSize = statSync(file).size;
      expect(() => createBuyerWallet(file, "mainnet")).toThrow();
      expect(statSync(file).size).toBe(originalSize);
      const link = join(dir, ".env.buyer.link");
      const target = join(dir, "absent");
      symlinkSync(target, link);
      expect(() => createBuyerWallet(link, "testnet")).toThrow();
      expect(existsSync(target)).toBe(false);
      expect(() => createBuyerWallet(join(dir, "wallet.txt"), "mainnet")).toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

import { CostGuard } from "../src/lib/costGuard.js";
import { confirmsPayment, createReconciler, AUTHORIZATION_USED, type ChainReader, type ChainLog } from "../src/payments/reconcile.js";
import { USDC, NETWORKS } from "../src/payments/x402.js";
import { encodeAbiParameters, encodeEventTopics, erc20Abi, type Hex } from "viem";

function uncertainPayment(store: Store) {
  const payer = `0x${"1".repeat(40)}` as Hex;
  const nonce = `0x${"2".repeat(64)}` as Hex;
  store.claim({ id: "uncertain", service_id: "keyword-metrics", data_source: "sandbox", price_usdc: 0.12, payment_key: "uncertain-key", network: NETWORKS.testnet, payer, input_hash: "h", input_json: "{}", result_token_hash: "token-hash" });
  store.recordAuthorization("uncertain", { nonce, asset: USDC.testnet.asset, to: PAY_TO, amount: "120000", validBefore: String(Math.floor(Date.now() / 1000) + 120) });
  store.startSettlement("uncertain-key");
  store.fail("uncertain", "settlement_uncertain");
  return store.get("uncertain")!;
}
function paymentLogs(row: ReturnType<typeof uncertainPayment>): ChainLog[] {
  const common = { address: USDC.testnet.asset, transactionHash: `0x${"3".repeat(64)}` as Hex, blockHash: `0x${"4".repeat(64)}` as Hex };
  return [
    { ...common, logIndex: 0, topics: encodeEventTopics({ abi: [AUTHORIZATION_USED], eventName: "AuthorizationUsed", args: { authorizer: row.payer as Hex, nonce: row.payment_nonce as Hex } }) as Hex[], data: "0x" },
    { ...common, logIndex: 1, topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from: row.payer as Hex, to: PAY_TO } }) as Hex[], data: encodeAbiParameters([{ type: "uint256" }], [120000n]) },
  ];
}
function mockChain(logs: ChainLog[]): ChainReader {
  const now = BigInt(Math.floor(Date.now() / 1000));
  return {
    head: vi.fn(async () => ({ number: 1100n, timestamp: now + 100n })),
    block: vi.fn(async (number: bigint) => ({ timestamp: now - 1000n + number })),
    authorizations: vi.fn(async () => logs.slice(0, 1)),
    receipt: vi.fn(async () => ({ status: "success", blockHash: logs[0]!.blockHash!, logs })),
  };
}

describe("R1: payment reservations and payer backoff", () => {
  it("refunds the exact reservation even when completions arrive out of order", () => {
    const store = new Store(":memory:");
    let now = 0;
    const guard = new CostGuard(store, { dailyUsd: 5, monthlyUsd: 100, countSpend: true }, () => now);
    try {
      const first = guard.reserve("s", 0.1, 0.1, 2);
      if ("refusal" in first) throw new Error("Unexpected refusal");
      now = 1000;
      const second = guard.reserve("s", 0.1, 0.1, 2);
      if ("refusal" in second) throw new Error("Unexpected refusal");
      first.release(); first.refundSlot(); first.refundSlot();
      expect(guard.check("s", 0.1, 0.1, 1)?.code).toBe("upstream_busy");
      // A payment still in flight never loses its reserved slot merely because a minute elapsed.
      now = 120000;
      expect(guard.check("s", 0.1, 0.1, 1)?.code).toBe("upstream_busy");
      second.release(); second.refundSlot();
      expect(guard.check("s", 0.1, 0.1, 1)).toBeNull();
    } finally { store.close(); }
  });
  it("backs off a failed payer, keeps its claim and frees capacity for other buyers", async () => {
    const events: Event[] = [];
    const fac = fakeFacilitator(events, { failSettle: true });
    const { app, store, guard } = buildTestApp({ fetchImpl: routedUpstream(events).impl, facilitator: fac });
    const base = await start(app);
    const sameBuyer = buyer();
    const first = await sameBuyer.pay(base + ROUTE, post(BODY));
    expect(first.status).toBe(402);
    const requestId = first.headers.get("x-request-id")!;
    expect(store.get(requestId)).toMatchObject({ status: "failed", error_code: "settlement_uncertain", settlement_started: 1 });
    expect(store.get(requestId)?.payment_nonce).toMatch(/^0x[\da-f]{64}$/);
    expect(guard.check("keyword-metrics", 0.09, 0.1, 1)).toBeNull();
    expect((await sameBuyer.pay(base + ROUTE, post(BODY))).status).toBe(429);
    expect(events.filter((e) => e === "settle")).toHaveLength(1);
    expect((await buyer().pay(base + ROUTE, post(BODY))).status).toBe(402);
    expect(events.filter((e) => e === "settle")).toHaveLength(2);
    expect(events).not.toContain("upstream");
  });
  it("preserves timeout attempts and refuses re-settlement of the same authorization", async () => {
    const events: Event[] = [];
    const fac = fakeFacilitator(events);
    fac.settle = async () => { events.push("settle"); throw new Error("simulated timeout"); };
    const { app, store } = buildTestApp({ fetchImpl: routedUpstream(events).impl, facilitator: fac });
    const base = await start(app);
    const client = new x402Client();
    registerExactEvmScheme(client, { signer: privateKeyToAccount(generatePrivateKey()) });
    let signature = "";
    const recording = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      signature = request.headers.get("payment-signature") ?? signature;
      return fetch(request);
    }) as typeof fetch;
    await wrapFetchWithPayment(recording, client)(base + ROUTE, post(BODY));
    expect(store.needsAttention()).toMatchObject([{ error_code: "settlement_uncertain" }]);
    const replay = await fetch(base + ROUTE, post(BODY, { "payment-signature": signature }));
    expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject({ error: "payment_pending" });
    expect(events).toEqual(["settle"]);
  });
});

describe("R2: read-only reconciliation of uncertain payments", () => {
  it("records a finalized matching payment exactly once without running a data call", async () => {
    const store = new Store(":memory:");
    try {
      const row = uncertainPayment(store);
      const reader = mockChain(paymentLogs(row));
      const run = createReconciler(store, "testnet", reader);
      await run(); await run();
      expect(store.get(row.id)).toMatchObject({ tx_hash: paymentLogs(row)[0]!.transactionHash, status: "failed", error_code: "settled_after_timeout", retries: 0 });
      expect(store.needsAttention()).toHaveLength(1);
      expect(reader.receipt).toHaveBeenCalledTimes(1);
      expect(store.beginRetry(row.id)).toBe(true);
    } finally { store.close(); }
  });
  it.each(["payer", "nonce", "recipient", "amount", "asset", "order"])("rejects a wrong %s in the on-chain proof", (field) => {
    const store = new Store(":memory:");
    try {
      const row = uncertainPayment(store);
      const logs = paymentLogs(row);
      if (field === "payer") row.payer = PAY_TO;
      if (field === "nonce") row.payment_nonce = `0x${"f".repeat(64)}`;
      if (field === "recipient") row.payment_to = row.payer;
      if (field === "amount") row.payment_amount = "1";
      if (field === "asset") logs[1]!.address = PAY_TO;
      if (field === "order") logs[1]!.logIndex = 10;
      expect(confirmsPayment(row, logs)).toBe(false);
    } finally { store.close(); }
  });
  it("keeps the cursor on RPC failure and does not confirm a failed receipt", async () => {
    const store = new Store(":memory:");
    try {
      const row = uncertainPayment(store);
      const reader = mockChain(paymentLogs(row));
      vi.mocked(reader.receipt).mockRejectedValueOnce(new Error("RPC down"));
      const run = createReconciler(store, "testnet", reader);
      await run();
      expect(store.get(row.id)?.reconciliation_cursor).toBeNull();
      expect(store.get(row.id)?.tx_hash).toBeNull();
      vi.mocked(reader.receipt).mockResolvedValueOnce({ status: "reverted", blockHash: paymentLogs(row)[0]!.blockHash!, logs: paymentLogs(row) });
      await run();
      expect(store.get(row.id)?.tx_hash).toBeNull();
      expect(store.get(row.id)?.reconciliation_cursor).not.toBeNull();
    } finally { store.close(); }
  });
  it("does no RPC work with no candidates or with candidates on the other network", async () => {
    const store = new Store(":memory:");
    try {
      const reader = mockChain([]);
      await createReconciler(store, "testnet", reader)();
      uncertainPayment(store);
      await createReconciler(store, "mainnet", reader)();
      expect(reader.head).not.toHaveBeenCalled();
    } finally { store.close(); }
  });
  it("rejects overlapping ticks", async () => {
    const store = new Store(":memory:");
    try {
      const row = uncertainPayment(store);
      const reader = mockChain(paymentLogs(row));
      const run = createReconciler(store, "testnet", reader);
      await Promise.all([run(), run()]);
      expect(reader.head).toHaveBeenCalledTimes(1);
      expect(reader.receipt).toHaveBeenCalledTimes(1);
    } finally { store.close(); }
  });
});

describe("Payment ledger failure safety", () => {
  it("aborts settlement before a facilitator call if the durable start marker cannot be written", async () => {
    const events: Event[] = [];
    const { app, store } = buildTestApp({ fetchImpl: routedUpstream(events).impl, facilitator: fakeFacilitator(events) });
    const mark = vi.spyOn(store, "startSettlement").mockReturnValue(false);
    try {
      const base = await start(app);
      const response = await buyer().pay(base + ROUTE, post(BODY));
      expect(response.status).toBe(402);
      expect(events).toEqual([]);
      expect(store.stats("day").perService).toEqual([]);
    } finally { mark.mockRestore(); }
  });
  it("cannot delete an attempted payment and recovers it after restart", () => {
    const store = new Store(":memory:");
    try {
      const row = uncertainPayment(store);
      store.db.prepare("UPDATE requests SET status='processing' WHERE id=?").run(row.id);
      store.release(row.id);
      expect(store.get(row.id)).toBeDefined();
      store.recoverAfterRestart();
      expect(store.get(row.id)).toMatchObject({ error_code: "interrupted_unsettled" });
      expect(store.reconciliationCandidates(NETWORKS.testnet)).toHaveLength(1);
    } finally { store.close(); }
  });
  it("stops scanning only after finalized history passes authorization expiry", async () => {
    const store = new Store(":memory:");
    try {
      const row = uncertainPayment(store);
      const reader = mockChain([]);
      const now = BigInt(Math.floor(Date.now() / 1000));
      vi.mocked(reader.head).mockResolvedValue({ number: 1600n, timestamp: now + 600n });
      const run = createReconciler(store, "testnet", reader);
      for (let i = 0; i < 5; i++) await run();
      expect(store.get(row.id)).toMatchObject({ tx_hash: null, error_code: "settlement_not_found" });
      expect(store.summary("day").totals.paid).toBe(0);
      expect(store.beginRetry(row.id)).toBe(false);
    } finally { store.close(); }
  });
  it("does not accept a receipt from a different block", async () => {
    const store = new Store(":memory:");
    try {
      const row = uncertainPayment(store);
      const logs = paymentLogs(row);
      const reader = mockChain(logs);
      vi.mocked(reader.receipt).mockResolvedValue({ status: "success", blockHash: `0x${"f".repeat(64)}`, logs });
      await createReconciler(store, "testnet", reader)();
      expect(store.get(row.id)?.tx_hash).toBeNull();
    } finally { store.close(); }
  });
});

it("an unverified long signature cannot put another payer on cooldown", async () => {
  const events: Event[] = [];
  const fac = fakeFacilitator(events);
  const { app } = buildTestApp({ fetchImpl: routedUpstream(events).impl, facilitator: fac });
  const base = await start(app);
  const client = new x402Client();
  registerExactEvmScheme(client, { signer: privateKeyToAccount(generatePrivateKey()) });
  let header = "";
  const recording = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    header = request.headers.get("payment-signature") ?? header;
    return fetch(request);
  }) as typeof fetch;
  const pay = wrapFetchWithPayment(recording, client);
  expect((await pay(base + ROUTE, post(BODY))).status).toBe(200);
  const forged = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  forged.payload.signature += "00";
  forged.payload.authorization.nonce = `0x${"f".repeat(64)}`;
  fac.settle = async (_, req) => ({ success: false, transaction: "", network: req.network, errorReason: "invalid_signature" });
  const rejected = await fetch(base + ROUTE, post(BODY, { "payment-signature": Buffer.from(JSON.stringify(forged)).toString("base64") }));
  expect(rejected.status).toBe(402);
  expect((await pay(base + ROUTE, post(BODY))).status).toBe(402); // Facilitator refusal, not a spoofed payer cooldown (429).
});

it("does not execute a paid handler unless the ledger confirms settlement", async () => {
  const events: Event[] = [];
  const { pipeline, store } = buildTestApp({ fetchImpl: routedUpstream(events).impl });
  const prepared = pipeline.prepare(pipeline.services.find((service) => service.id === "keyword-metrics")!, BODY);
  if (!prepared.ok) throw new Error("Unexpected invalid input");
  const claim = pipeline.claim(prepared.prepared, { key: "missing-settlement", network: NETWORKS.testnet, payer: PAY_TO, priceUsdc: 0.12 })!;
  const out = await pipeline.runClaimed(prepared.prepared, claim.requestId, claim.resultToken, { paid: true, via: "rest" });
  expect(out.status).toBe(503);
  expect(out.body).toMatchObject({ error: "payment_pending", request_id: claim.requestId });
  expect(store.get(claim.requestId)?.error_code).toBe("settlement_uncertain");
  expect(events).toEqual([]);
});

it("keeps each reconciliation query within the public RPC 200-block limit and resumes at the next block", async () => {
  const store = new Store(":memory:");
  try {
    const row = uncertainPayment(store);
    const reader = mockChain([]);
    const run = createReconciler(store, "testnet", reader);
    await run();
    const cursor = BigInt(store.get(row.id)!.reconciliation_cursor!);
    await run();
    const calls = vi.mocked(reader.authorizations).mock.calls;
    expect(calls).toHaveLength(2);
    for (const [from, to] of calls) expect(to - from + 1n).toBeLessThanOrEqual(200n);
    expect(calls[1]![0]).toBe(cursor);
    expect(calls[1]![0]).toBe(calls[0]![1] + 1n);
  } finally { store.close(); }
});

import { createDataForSeoClient } from "../src/dataforseo/client.js";
import { Pipeline } from "../src/services/pipeline.js";
import { SERVICES } from "../src/services/index.js";
import { createFreeSample } from "../src/freeSample.js";
import { runInNewContext } from "node:vm";

describe("2026-10-23 cost protection regressions", () => {
  function livePipeline(fetchImpl: typeof fetch, dailyUsd = 5) {
    const store = new Store(":memory:");
    const guard = new CostGuard(store, { dailyUsd, monthlyUsd: 100, countSpend: true });
    const dfs = createDataForSeoClient({ mode: "live", login: "dummy", password: "dummy", timeoutMs: 1000, fetchImpl });
    return { store, pipeline: new Pipeline({ store, guard, dfs, services: SERVICES }) };
  }

  it.each(["network", "invalid-json"])("keeps the sample slot and reserves worst-case cost after ambiguous %s failure", async (kind) => {
    const fetchImpl = (async () => {
      if (kind === "network") throw new TypeError("connection lost after submission");
      return new Response("truncated response", { status: 200 });
    }) as typeof fetch;
    const { store, pipeline } = livePipeline(fetchImpl);
    try {
      const sample = createFreeSample({ store, pipeline, dailyLimit: 1 });
      expect((await sample.run("192.0.2.1", { keyword: "alpha" })).status).toBe(502);
      expect(store.upstreamSpendSince(new Date().toISOString().slice(0, 10))).toBeCloseTo(0.09);
      expect(sample.info().available_today).toBe(false);
      expect((await sample.run("192.0.2.2", { keyword: "beta" })).status).toBe(429);
    } finally { store.close(); }
  });

  it("counts a retry of an older purchase against today's and this month's budget", async () => {
    const ff = fakeFetch(fixture("google-ads-search-volume.json"));
    const { store, pipeline } = livePipeline(ff.impl, 0.09);
    try {
      const service = SERVICES.find((s) => s.id === "keyword-metrics")!;
      const prep = pipeline.prepare(service, { keywords: ["alpha"] });
      if (!prep.ok) throw new Error("invalid fixture");
      const claim = pipeline.claim(prep.prepared, { key: "old-paid-call", network: "eip155:8453", payer: null, priceUsdc: 0.12 })!;
      store.setSettled(claim.requestId, "offline-tx", null);
      store.fail(claim.requestId, "upstream_error");
      store.db.prepare("UPDATE requests SET created_at='2020-01-01T00:00:00.000Z' WHERE id=?").run(claim.requestId);
      expect((await pipeline.retry(claim.requestId, claim.resultToken)).status).toBe(200);
      expect(ff.calls).toHaveLength(1);
      const day = new Date().toISOString().slice(0, 10);
      expect(store.upstreamSpendSince(day)).toBeCloseTo(0.09);
      expect(store.upstreamSpendSince(day.slice(0, 7) + "-01")).toBeCloseTo(0.09);
      const next = pipeline.prepare(service, { keywords: ["beta"] });
      expect(next).toMatchObject({ ok: false, body: { error: "daily_budget" } });
    } finally { store.close(); }
  });

  it("migrates historical costs once and retains new execution-day costs across reopening and backup", () => {
    const directory = mkdtempSync(join(tmpdir(), "cost-migration-"));
    const database = join(directory, "ledger.db");
    let store = new Store(database);
    try {
      store.claim({ id: "old", service_id: "keyword-metrics", data_source: "live", price_usdc: 0.12,
        payment_key: "old", network: "eip155:8453", payer: null, input_hash: null, input_json: null, result_token_hash: null });
      store.db.exec("DROP TRIGGER book_upstream_spend; DROP TABLE upstream_spend;");
      store.db.exec("UPDATE requests SET created_at='2020-01-01T00:00:00.000Z', upstream_cost_usd=0.09");
      store.close();
      store = new Store(database);
      expect(store.upstreamSpendSince("2020-01-01")).toBeCloseTo(0.09);
      expect(store.upstreamSpendSince("2021-01-01")).toBe(0);
      store.fail("old", "network", 0.09);
      store.close();
      store = new Store(database);
      expect(store.upstreamSpendSince("2020-01-01")).toBeCloseTo(0.18);
      expect(store.upstreamSpendSince(new Date().toISOString().slice(0, 10))).toBeCloseTo(0.09);
      const file = backupLedger(database, join(directory, "backups"), 30);
      const restored = new Store(join(directory, "backups", file));
      try { expect(restored.upstreamSpendSince("2020-01-01")).toBeCloseTo(0.18); }
      finally { restored.close(); }
    } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
  });
});

describe("browser purchase recovery", () => {
  function setup() {
    const window: Record<string, any> = {};
    runInNewContext(readFileSync(new URL("../public/agentur.js", import.meta.url), "utf8"), { window });
    const data = new Map<string, string>();
    const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); }, removeItem: (k: string) => { data.delete(k); } };
    let locked = false;
    const locks = { request: async (_k: string, _opts: unknown, fn: (l: object | null) => Promise<unknown>) => {
      if (locked) return fn(null);
      locked = true;
      try { return await fn({}); } finally { locked = false; }
    } };
    const make = (send: typeof fetch, s = storage, l: unknown = locks) => window.AgenturPay.createPurchaseSession(s, l, send);
    const authorize = vi.fn(async () => ({ path: "/api/v1/google-serp", input: { keyword: "coffee" }, header: "secret-signature" }));
    const confirm = vi.fn(async () => true);
    return { storage, data, make, authorize, confirm };
  }

  it("blocks another authorization after response loss, including after reload", async () => {
    const t = setup();
    const send = vi.fn(async () => { throw new Error("lost response after settlement"); });
    await expect(t.make(send).run(t.authorize, t.confirm)).rejects.toThrow("lost response");
    await expect(t.make(send).run(t.authorize, t.confirm)).rejects.toThrow(/ungeklärt/);
    expect(t.authorize).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect([...t.data.values()].join()).not.toContain("secret-signature");
  });

  it("serializes tabs and blocks signing when durable storage is unavailable", async () => {
    const t = setup();
    let finish!: () => void;
    const send = vi.fn(async () => { await new Promise<void>((r) => { finish = r; }); return Response.json({ request_id: "r", result: {} }); });
    const first = t.make(send).run(t.authorize, t.confirm);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    await expect(t.make(send).run(t.authorize, t.confirm)).rejects.toThrow(/anderen Tab/);
    finish(); await first;
    const unavailable = { ...t.storage, setItem: () => { throw new Error("storage unavailable"); } };
    t.data.clear();
    await expect(t.make(send, unavailable).run(t.authorize, t.confirm)).rejects.toThrow("storage unavailable");
    await expect(t.make(send, t.storage, null).run(t.authorize, t.confirm)).rejects.toThrow(/Web Locks/);
    expect(t.authorize).toHaveBeenCalledTimes(1);
  });

  it("recovers a known paid result with GET and never signs or pays again", async () => {
    const t = setup();
    const send = vi.fn(async (_url: unknown, opts?: RequestInit) => opts?.method === "POST"
      ? Response.json({ request_id: "r", result_token: "private-result-token", error: "upstream_timeout" }, { status: 504 })
      : Response.json({ request_id: "r", service: "google-serp", result: { items: [] } }));
    expect((await t.make(send).run(t.authorize, t.confirm)).ok).toBe(false);
    const restored = await t.make(send).run(t.authorize, t.confirm);
    expect(restored.body.result_token).toBe("private-result-token");
    expect(send.mock.calls[1]).toEqual(["/api/v1/results/r", { headers: { authorization: "Bearer private-result-token" }, cache: "no-store" }]);
    expect(t.authorize).toHaveBeenCalledTimes(1);
    expect(t.make(send).read().state).toBe("completed");
    const no = vi.fn(async () => false);
    await t.make(send).run(t.authorize, no);
    expect(t.authorize).toHaveBeenCalledTimes(1);
    expect(no).toHaveBeenCalledTimes(1);
  });

  it("allows a new purchase only after completion and explicit confirmation; cancellation stores nothing", async () => {
    const t = setup();
    const send = vi.fn(async () => Response.json({ request_id: "r", result: {} }));
    await t.make(send).run(async () => null, t.confirm);
    expect(t.data.size).toBe(0);
    await t.make(send).run(t.authorize, t.confirm);
    await t.make(send).run(t.authorize, t.confirm);
    expect(t.confirm).toHaveBeenCalledTimes(1);
    expect(t.authorize).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(2);
  });
});
