/**
 * MCP integration tests with REAL MCP clients (official SDK client over Streamable HTTP) and the REAL
 * @x402/mcp payment client. Only the facilitator is simulated; no network, no real funds.
 */
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createx402MCPClient } from "@x402/mcp";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { buildTestApp, fixture } from "./helpers.js";
import { fakeFacilitator, routedUpstream, start, upstream, type Event } from "./x402helpers.js";
import { SERVICES } from "../src/services/index.js";
import { toolNameOf } from "../src/services/common.js";

const NETWORK = "eip155:84532";
const FREE_TOOLS = ["get_result", "list_services", "preflight", "retry_request", "wishlist"];

const parse = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0]!.text);

async function plainClient(base: string) {
  const client = new Client({ name: "plain-test-client", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp")));
  return client;
}

/** x402-capable MCP client; also records every request body so a payment can be replayed on the wire. */
async function payingClient(base: string) {
  const bodies: string[] = [];
  const recording = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof init?.body === "string") bodies.push(init.body);
    return fetch(input, init);
  }) as typeof fetch;
  const client = createx402MCPClient({
    name: "paying-test-client",
    version: "1.0.0",
    schemes: [{ network: NETWORK, client: new ExactEvmScheme(privateKeyToAccount(generatePrivateKey())) }],
    autoPayment: true,
    onPaymentRequested: async () => true,
  });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp"), { fetch: recording }));
  return { client, bodies };
}

describe("MCP server", () => {
  it("lists free tools and one paid tool per service; paid tools say honestly that an x402 client is required", async () => {
    const { app } = buildTestApp({ fetchImpl: routedUpstream([]).impl, facilitator: fakeFacilitator([]) });
    const c = await plainClient(await start(app));
    const { tools } = await c.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([...FREE_TOOLS, ...SERVICES.map((s) => toolNameOf(s.id))].sort());
    for (const s of SERVICES) {
      const t = tools.find((x) => x.name === toolNameOf(s.id))!;
      expect(t.description).toContain(`${s.priceUsdc} USDC`);
      expect(t.description).toMatch(/x402-capable MCP client/);
      expect(t.description).toMatch(/charges nothing/);
      expect(t.description).not.toMatch(/automatically pays/i);
      expect(t.inputSchema.type).toBe("object");
      expect(t.inputSchema.additionalProperties).toBe(false);
      expect(t.inputSchema.properties).toBeTruthy();
    }
    const kw = tools.find((t) => t.name === "keyword_metrics")!;
    expect((kw.inputSchema.properties!.keywords as { description: string }).description).toMatch(/1000/);
    await c.close();
  });

  it("a plain client (no payment support) can use free tools; a paid call returns 'payment required', charges nothing and calls nothing", async () => {
    const events: Event[] = [];
    const { app, store } = buildTestApp({ fetchImpl: routedUpstream(events).impl, facilitator: fakeFacilitator(events) });
    const c = await plainClient(await start(app));

    const list = parse(await c.callTool({ name: "list_services", arguments: {} }));
    expect(list.services.map((s: { mcp_tool: string }) => s.mcp_tool).sort()).toEqual(SERVICES.map((s) => toolNameOf(s.id)).sort());
    expect(list.network).toBe(NETWORK);

    const pre = parse(await c.callTool({ name: "preflight", arguments: { service: "competitors", input: { domain: "https://www.Example.com/x", location_code: 2276 } } }));
    expect(pre).toMatchObject({ ok: true, normalized_input: { domain: "example.com", location_code: 2276, language_code: "de" } });

    const paid = await c.callTool({ name: "keyword_metrics", arguments: { keywords: ["seo"] } });
    expect(paid.isError).toBe(true);
    expect(paid.structuredContent).toMatchObject({ x402Version: 2, accepts: [{ scheme: "exact", network: NETWORK, amount: "120000" }] });
    expect(events).toEqual([]);
    expect(store.stats("day").perService).toEqual([]);
    await c.close();
  });

  it("refuses invalid input BEFORE any payment challenge, also for a paying client", async () => {
    const events: Event[] = [];
    const { app } = buildTestApp({ fetchImpl: routedUpstream(events).impl, facilitator: fakeFacilitator(events) });
    const { client } = await payingClient(await start(app));
    const bad = await client.callTool("keyword_metrics", { keywords: [] });
    expect(bad.paymentMade).toBe(false);
    expect(bad.isError).toBe(true);
    expect(parse(bad).message).toContain("Nothing was charged");
    const loc = await client.callTool("competitors", { domain: "example.com", location_code: 2276, language_code: "en" });
    expect(loc.paymentMade).toBe(false);
    expect(parse(loc).error).toBe("unsupported_parameters");
    expect(events).toEqual([]);
    await client.close();
  });

  it("an x402-capable client pays automatically for every tool: settle BEFORE upstream, one task, mapped result", async () => {
    const events: Event[] = [];
    const up = routedUpstream(events);
    const fac = fakeFacilitator(events);
    const { app, store } = buildTestApp({ fetchImpl: up.impl, facilitator: fac });
    const { client } = await payingClient(await start(app));
    for (const s of SERVICES) {
      events.length = 0;
      up.calls.length = 0;
      const out = await client.callTool(toolNameOf(s.id), s.example as Record<string, unknown>);
      expect(out.isError, s.id).toBeFalsy();
      expect(out.paymentMade, s.id).toBe(true);
      expect(out.paymentResponse, s.id).toMatchObject({ success: true, network: NETWORK });
      const body = parse(out);
      expect(body, s.id).toMatchObject({ service: s.id, data_source: "sandbox", cached: false });
      expect(body.result_token, s.id).toBeTruthy();
      const endpoints = [s.upstream.endpoint, ...(s.extraSteps ?? []).map((x) => x.endpoint)];
      expect(events, s.id).toEqual(["settle", ...endpoints.map(() => "upstream")]);
      expect(up.calls.map((c) => c.endpoint).sort(), s.id).toEqual([...endpoints].sort());
      expect(store.get(body.request_id), s.id).toMatchObject({ status: "completed", price_usdc: Number(s.priceUsdc) });
      if (s.id === "ai-keyword-demand") expect(body.result.estimate).toBe(true);
    }
    expect(fac.settles()).toBe(SERVICES.length);
    await client.close();
  });

  it("replaying the same MCP payment returns the stored result without settling or calling upstream again", async () => {
    const events: Event[] = [];
    const fac = fakeFacilitator(events);
    const { app } = buildTestApp({ fetchImpl: routedUpstream(events).impl, facilitator: fac });
    const base = await start(app);
    const { client, bodies } = await payingClient(base);
    const first = parse(await client.callTool("keyword_ideas", { keywords: ["running shoes"] }));
    // The retried tools/call carrying the payment in _meta["x402/payment"]:
    const withPayment = bodies.map((b) => JSON.parse(b)).find((m) => m.method === "tools/call" && m.params?._meta?.["x402/payment"]);
    expect(withPayment).toBeTruthy();
    await client.close();

    const raw = await fetch(base + "/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ ...withPayment, id: 99 }),
    });
    const replay = (await raw.json()).result.structuredContent;
    expect(replay).toMatchObject({ request_id: first.request_id, replayed: true });
    expect(replay.result_token).not.toBe(first.result_token);
    expect(events.filter((e) => e === "upstream")).toHaveLength(1);
    expect(fac.settles()).toBe(1);
  });

  it("settlement failure: no upstream call, durable uncertain payment", async () => {
    const events: Event[] = [];
    const { app, store } = buildTestApp({ fetchImpl: routedUpstream(events).impl, facilitator: fakeFacilitator(events, { failSettle: true }) });
    const { client } = await payingClient(await start(app));
    const out = await client.callTool("search_intent", { keywords: ["buy shoes"] });
    expect(out.isError).toBe(true);
    expect(events).not.toContain("upstream");
    expect(store.stats("day").perService).toMatchObject([{ paid: 0, revenue_usdc: 0, failed: 1 }]);
    expect(store.needsAttention()).toMatchObject([{ error_code: "settlement_uncertain" }]);
    await client.close();
  });

  it("upstream failure after payment: error with request_id + token and receipt; free retry_request works once", async () => {
    const events: Event[] = [];
    const failing = { status_code: 50000, status_message: "Internal Error.", cost: 0, tasks: [] };
    const fac = fakeFacilitator(events);
    const up = upstream(events, [failing, fixture("labs-search-intent.json")]);
    const { app } = buildTestApp({ fetchImpl: up.impl, facilitator: fac });
    const { client } = await payingClient(await start(app));
    const out = await client.callTool("search_intent", { keywords: ["login page"] });
    expect(out.isError).toBe(true);
    expect(out.paymentResponse).toMatchObject({ success: true });
    const body = parse(out);
    expect(body).toMatchObject({ error: "upstream_error", paid: true, retry_available: true });
    expect(body.retry).toMatch(/retry_request/);

    const retried = parse(await client.client.callTool({ name: "retry_request", arguments: { request_id: body.request_id, result_token: body.result_token } }));
    expect(retried.result.keywords.length).toBeGreaterThan(0);
    const again = await client.client.callTool({ name: "retry_request", arguments: { request_id: body.request_id, result_token: body.result_token } });
    expect(again.isError).toBe(true);
    const wrong = await client.client.callTool({ name: "get_result", arguments: { request_id: body.request_id, result_token: "wrong" } });
    expect(wrong.isError).toBe(true);
    const fetched = parse(await client.client.callTool({ name: "get_result", arguments: { request_id: body.request_id, result_token: body.result_token } }));
    expect(fetched.result.keywords.length).toBeGreaterThan(0);
    expect(fac.settles()).toBe(1);
    expect(events.filter((e) => e === "upstream")).toHaveLength(2);
    await client.close();
  });

  it("a disabled service has no tool", async () => {
    const { app } = buildTestApp({ fetchImpl: routedUpstream([]).impl, facilitator: fakeFacilitator([]), disabled: ["competitors"] });
    const c = await plainClient(await start(app));
    const names = (await c.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("competitors");
    const res = await c.callTool({ name: "competitors", arguments: { domain: "example.com" } });
    expect(res.isError).toBe(true);
    await c.close();
  });

  it("is stateless Streamable HTTP: POST only", async () => {
    const { app } = buildTestApp({ fetchImpl: routedUpstream([]).impl, facilitator: fakeFacilitator([]) });
    const base = await start(app);
    const get = await fetch(base + "/mcp");
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
    const del = await fetch(base + "/mcp", { method: "DELETE" });
    expect(del.status).toBe(405);
  });

  it("sandbox development mode (no payments) serves paid tools with dummy data", async () => {
    const { app } = buildTestApp({ fetchImpl: routedUpstream([]).impl });
    const c = await plainClient(await start(app));
    const { tools } = await c.listTools();
    expect(tools.find((t) => t.name === "keyword_metrics")!.description).toMatch(/SANDBOX/);
    const out = await c.callTool({ name: "keyword_metrics", arguments: { keywords: ["seo"] } });
    expect(out.isError).toBeFalsy();
    expect(parse(out)).toMatchObject({ data_source: "sandbox" });
    await c.close();
  });
});
