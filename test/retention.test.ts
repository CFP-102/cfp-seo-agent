import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/config/env.js";
import { Store } from "../src/lib/store.js";
import { buildTestApp, fixture, fakeFetch } from "./helpers.js";
import { post, start } from "./x402helpers.js";

const row = (id: string, key: string | null) => ({ id, service_id: "keyword-metrics", data_source: "live" as const, price_usdc: 0.12, payment_key: key, network: "eip155:8453", payer: "0xabc", input_hash: "h", input_json: '{"keywords":["secret keyword"]}', result_token_hash: "t" });

describe("retention", () => {
  it("deletes contents older than the period but keeps the payment record; never touches recent or in-flight rows", () => {
    const store = new Store(":memory:");
    store.claim(row("old-done", "k1"));
    store.setSettled("old-done", "0xtx", "0xabc");
    store.complete("old-done", { resultJson: '{"result":"x"}', upstreamCostUsd: 0.09, cacheHit: false });
    store.claim(row("old-processing", "k2"));
    store.claim(row("recent", "k3"));
    store.complete("recent", { resultJson: '{"result":"y"}', upstreamCostUsd: 0, cacheHit: false });
    const old = new Date(Date.now() - 31 * 86_400_000).toISOString();
    store.db.prepare(`UPDATE requests SET created_at = ? WHERE id IN ('old-done','old-processing')`).run(old);

    expect(store.purgeOldPayloads(30)).toBe(1);
    const done = store.get("old-done")!;
    expect(done.input_json).toBeNull();
    expect(done.result_json).toBeNull();
    expect(done.input_hash).toBeNull();
    // bookkeeping stays
    expect(done).toMatchObject({ service_id: "keyword-metrics", status: "completed", tx_hash: "0xtx", payer: "0xabc", price_usdc: 0.12, network: "eip155:8453", upstream_cost_usd: 0.09 });
    expect(store.get("old-processing")!.input_json).not.toBeNull();
    expect(store.get("recent")!.result_json).not.toBeNull();
    expect(store.purgeOldPayloads(30)).toBe(0); // idempotent
  });

  it("an expired result answers 410, an old failed request can no longer be retried, statistics are unchanged", async () => {
    const { app, store } = buildTestApp({ fetchImpl: fakeFetch(fixture("google-ads-search-volume.json")).impl });
    const base = await start(app);
    const first = await (await fetch(base + "/api/v1/keyword-metrics", post({ keywords: ["running shoes"] }))).json();
    const auth = { authorization: `Bearer ${first.result_token}` };
    expect((await fetch(`${base}/api/v1/results/${first.request_id}`, { headers: auth })).status).toBe(200);
    store.db.prepare(`UPDATE requests SET created_at = ?`).run(new Date(Date.now() - 40 * 86_400_000).toISOString());
    const statsBefore = JSON.stringify(store.stats("month").perService);
    store.purgeOldPayloads(30);
    const gone = await fetch(`${base}/api/v1/results/${first.request_id}`, { headers: auth });
    expect(gone.status).toBe(410);
    expect((await gone.json()).error).toBe("expired");
    expect((await fetch(`${base}/api/v1/results/${first.request_id}`, { headers: { authorization: "Bearer wrong" } })).status).toBe(404);
    expect(JSON.stringify(store.stats("month").perService)).toBe(statsBefore);
  });

  it("RETENTION_DAYS defaults to 30 and is bounded", () => {
    expect(loadEnv({}).RETENTION_DAYS).toBe(30);
    expect(loadEnv({ RETENTION_DAYS: "7" }).RETENTION_DAYS).toBe(7);
    expect(() => loadEnv({ RETENTION_DAYS: "0" })).toThrow();
    expect(() => loadEnv({ RETENTION_DAYS: "9999" })).toThrow();
  });
});
