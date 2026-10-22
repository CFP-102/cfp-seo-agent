import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildTestApp, fakeFetch, fixture } from "./helpers.js";
import { start } from "./x402helpers.js";
import { SERVICES } from "../src/services/index.js";
import { readFileSync } from "node:fs";

const ENV = { TRUST_PROXY: "1", ADMIN_USER: "boss", ADMIN_PASSWORD: "correct-horse-battery-staple-123" };
const wish = (base: string, ip: string, body: unknown) =>
  fetch(base + "/api/v1/wishlist", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify(body) });
const fx = () => fixture("google-ads-search-volume.json");

describe("wishlist", () => {
  it("stores a short text, is listed in catalog and OpenAPI, and is write-only", async () => {
    const { app, store } = buildTestApp({ fetchImpl: fakeFetch(fx()).impl, env: ENV });
    const base = await start(app);
    const res = await wish(base, "1.1.1.1", { text: "  Backlink summary for a domain, about 0.05 USDC  " });
    expect(res.status).toBe(200);
    expect(store.recentWishes()[0]!.text).toBe("Backlink summary for a domain, about 0.05 USDC");
    expect((await (await fetch(base + "/api/v1/services")).json()).wishlist).toMatchObject({ path: "/api/v1/wishlist" });
    expect((await (await fetch(base + "/openapi.json")).json()).paths["/api/v1/wishlist"]).toBeTruthy();
    // No public read route.
    expect((await fetch(base + "/api/v1/wishlist")).status).toBeGreaterThanOrEqual(404);
  });

  it("validates strictly: length, unknown fields, control characters", async () => {
    const { app, store } = buildTestApp({ fetchImpl: fakeFetch(fx()).impl, env: ENV });
    const base = await start(app);
    for (const body of [{}, { text: "short" }, { text: "x".repeat(301) }, { text: "ok text here", extra: 1 }, { text: "bad\u0000control chars" }, { text: 42 }]) {
      expect((await wish(base, "2.2.2.2", body)).status, JSON.stringify(body).slice(0, 40)).toBe(400);
    }
    expect(store.recentWishes()).toHaveLength(0);
  });

  it("limits wishes per client per day (IPv6 by /64) and per day in total", async () => {
    const { app, store } = buildTestApp({ fetchImpl: fakeFetch(fx()).impl, env: ENV });
    const base = await start(app);
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await wish(base, `2001:db8:1:2::${i + 1}`, { text: `Wish number ${i} for a new tool` })).status);
    expect(codes).toEqual([200, 200, 200, 429, 429]);
    expect((await wish(base, "3.3.3.3", { text: "A different client may still wish" })).status).toBe(200);
    expect(store.recentWishes()).toHaveLength(4);
  });

  it("works as a free MCP tool and shows up escaped in the admin page; old wishes are purged", async () => {
    const { app, store } = buildTestApp({ fetchImpl: fakeFetch(fx()).impl, env: ENV });
    const base = await start(app);
    const c = new Client({ name: "t", version: "1" });
    await c.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp")));
    expect((await c.listTools()).tools.map((t) => t.name)).toContain("wishlist");
    const out = await c.callTool({ name: "wishlist", arguments: { text: "<script>alert(1)</script> tool please" } });
    expect(out.isError).toBeFalsy();
    await c.close();
    const auth = { headers: { authorization: "Basic " + Buffer.from("boss:" + ENV.ADMIN_PASSWORD).toString("base64") } };
    const html = await (await fetch(base + "/admin", auth)).text();
    expect(html).toContain("Wishlist");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; tool please");
    expect(html).not.toContain("<script>alert(1)");
    store.addWish("old wish that should be deleted", new Date(Date.now() - 60 * 86_400_000));
    store.purgeOldPayloads(30);
    expect(store.recentWishes().map((w) => w.text).join("|")).not.toContain("old wish");
  });
});

describe("recipes.json", () => {
  it("only references existing services and grants no purchase authority", async () => {
    const { app } = buildTestApp({ fetchImpl: fakeFetch(fx()).impl, env: ENV });
    const base = await start(app);
    const res = await fetch(base + "/recipes.json");
    expect(res.status).toBe(200);
    const doc = await res.json();
    const ids = new Set(SERVICES.map((s) => s.id));
    expect(doc.recipes.length).toBeGreaterThan(2);
    for (const r of doc.recipes) for (const step of r.steps) expect(ids.has(step.service), step.service).toBe(true);
    expect(doc.note).toMatch(/does not approve a purchase/);
    expect(readFileSync(new URL("../public/llms.txt", import.meta.url), "utf8")).toContain("/recipes.json");
  });
});
