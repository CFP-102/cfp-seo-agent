import { describe, expect, it } from "vitest";
import { buildTestApp } from "./helpers.js";
import { routedUpstream, start } from "./x402helpers.js";
import { buildStatus } from "../src/web/status.js";

const ENV = { FREE_SAMPLE_DAILY_LIMIT: "5", CONTACT_EMAIL: "info@example.com" };

describe("German homepage, status page and agent cards", () => {
  it("serves /de/ in German with a language switch, and the English page links back", async () => {
    const { app } = buildTestApp({ fetchImpl: routedUpstream([]).impl, env: ENV });
    const base = await start(app);
    const de = await (await fetch(base + "/de/")).text();
    expect(de).toContain('<html lang="de">');
    expect(de).toContain('href="/" hreflang="en"');
    expect(de).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(de).toContain('data-id="google-serp"');
    const en = await (await fetch(base + "/")).text();
    expect(en).toContain('href="/de/" hreflang="de"');
    expect(en).toContain("Built for agencies and agents in DACH");
  });

  it("status page (EN/DE) and status.json show uptime and delivery success without caller data", async () => {
    const { app, store } = buildTestApp({ fetchImpl: routedUpstream([]).impl, env: ENV });
    const now = new Date();
    for (let m = 0; m < 30; m++) store.beat(new Date(now.getTime() - m * 60_000));
    store.claim({ id: "p1", service_id: "google-serp", data_source: "live", price_usdc: 0.025, payment_key: "k1", network: "eip155:8453", payer: "0xPAYER", input_hash: "h", input_json: "{}", result_token_hash: "t" });
    store.setSettled("p1", "0xtx", "0xPAYER");
    store.complete("p1", { resultJson: "{}", upstreamCostUsd: 0.002, cacheHit: false });
    const base = await start(app);
    const json = await (await fetch(base + "/status.json")).json();
    expect(json.uptime_pct.last_24h).toBeGreaterThan(90);
    expect(json.days).toHaveLength(30);
    expect(json.services.find((s: any) => s.id === "google-serp").paid_delivery_success_pct_30d).toBe(100);
    expect(JSON.stringify(json)).not.toMatch(/0xPAYER|0xtx|revenue|usdc/i);
    const en = await fetch(base + "/status");
    expect(en.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await en.text();
    expect(html).toContain("Status and trust");
    expect(html).not.toMatch(/<script/i);
    expect(await (await fetch(base + "/de/status")).text()).toContain("Status und Vertrauen");
  });

  it("a minute without heartbeat counts as downtime", () => {
    const { store, pipeline } = buildTestApp({ fetchImpl: routedUpstream([]).impl, env: ENV }) as any;
    const now = new Date("2026-10-23T12:00:30Z");
    for (let m = 0; m <= 9; m++) if (m !== 5) store.beat(new Date(now.getTime() - m * 60_000));
    const st = buildStatus(store, pipeline, now);
    expect(st.uptime_pct.last_24h).toBe(90);
  });

  it("agent card and MCP server card describe only what exists", async () => {
    const { app } = buildTestApp({ fetchImpl: routedUpstream([]).impl, env: ENV });
    const base = await start(app);
    const card = await (await fetch(base + "/.well-known/agent.json")).json();
    expect(card.interfaces.mcp.url).toBe("http://api.test/mcp".replace("http://api.test", card.url));
    expect(card.skills.length).toBeGreaterThan(15);
    expect(card.skills.find((s: any) => s.id === "local-market-check").free_sample).toBe(false);
    expect(card.skills.find((s: any) => s.id === "google-serp").free_sample).toBe(true);
    expect(card.data_handling.ip_addresses_stored).toBe(false);
    const mcp = await (await fetch(base + "/.well-known/mcp/server-card.json")).json();
    expect(mcp.transport).toMatchObject({ type: "streamable-http" });
  });
});

describe("fonts", () => {
  it("every HTML page allows its own font files (CSP font-src 'self')", async () => {
    const { app } = buildTestApp({ fetchImpl: routedUpstream([]).impl, env: ENV });
    const base = await start(app);
    for (const p of ["/", "/de/", "/de/agenturen", "/status", "/de/status", "/legal.html", "/legal-de.html", "/quickstart.html"]) {
      const res = await fetch(base + p);
      expect(res.headers.get("content-security-policy"), p).toContain("font-src 'self'");
    }
  });
});
