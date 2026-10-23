/**
 * Website, OpenAPI 3.1, discovery metadata and crawler-probe behaviour.
 */
import { describe, expect, it } from "vitest";
import { Validator } from "@seriousme/openapi-schema-validator";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { buildTestApp, fixture, PAY_TO } from "./helpers.js";
import { fakeFacilitator, post, routedUpstream, start, buyer, type Event } from "./x402helpers.js";
import { SERVICES } from "../src/services/index.js";
import { toolNameOf } from "../src/services/common.js";
import { render } from "../src/web/site.js";

const paid = (events: Event[] = []) => buildTestApp({ fetchImpl: routedUpstream(events).impl, facilitator: fakeFacilitator(events), env: { PUBLIC_BASE_URL: "https://agent.example.com", CONTACT_EMAIL: "ops@example.com" } });

describe("public purchase guide", () => {
  it("renders current price and merchant with no unresolved placeholders and links the guarded example", async () => {
    const { app } = buildTestApp({ fetchImpl: routedUpstream([]).impl, env: { PAY_TO_ADDRESS: PAY_TO } });
    const base = await start(app);
    const response = await fetch(base + "/quickstart.html");
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(html).toContain(PAY_TO);
    expect(html).toContain("APPROVE_USDC=0.025");
    expect(html).toContain("/examples/buyer.mjs");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect((await (await fetch(base + "/")).text())).toContain('href="/quickstart.html"');
    const example = await fetch(base + "/examples/buyer.mjs");
    expect(example.status).toBe(200);
    expect(await example.text()).toContain("openSync(journal, 'wx', 0o600)");
  });
});

describe("OpenAPI 3.1", () => {
  it("is valid against the official OpenAPI 3.1 schema", async () => {
    const { app } = paid();
    const doc = await (await fetch((await start(app)) + "/openapi.json")).json();
    const result = await new Validator().validate(doc);
    expect(result.errors ?? null, JSON.stringify(result.errors)).toBeFalsy();
    expect(result.valid).toBe(true);
    expect(doc.openapi).toBe("3.1.0");
  });

  it("describes every paid route with x402 price metadata, a 402 response, request schema and examples", async () => {
    const { app } = paid();
    const doc = await (await fetch((await start(app)) + "/openapi.json")).json();
    expect(doc.servers[0].url).toBe("https://agent.example.com");
    expect(doc.info).toMatchObject({ title: "Agent Data API", contact: { email: "ops@example.com" } });
    expect(doc.info["x-guidance"]).toMatch(/preflight/);
    expect(doc.info["x-mcp"].url).toBe("https://agent.example.com/mcp");
    expect(doc.info.termsOfService).toBe("https://agent.example.com/legal.html#terms");
    expect(doc.info.description).toMatch(/businesses only \(B2B\)/);
    for (const s of SERVICES) {
      const op = doc.paths[s.route].post;
      expect(op["x-payment-info"], s.id).toEqual({ price: { mode: "fixed", currency: "USD", amount: Number(s.priceUsdc).toFixed(6) }, protocols: [{ x402: {} }] });
      expect(op.responses["402"].description, s.id).toBe("Payment Required");
      expect(op.requestBody.content["application/json"].schema.additionalProperties, s.id).toBe(false);
      expect(op.requestBody.content["application/json"].examples.default.value, s.id).toEqual(s.example);
      expect(op.description, s.id).toContain(toolNameOf(s.id));
    }
    expect(doc.paths["/api/v1/services"].get.security).toEqual([]);
    expect(doc.paths["/api/v1/preflight/{serviceId}"].post.security).toEqual([]);
    expect(doc.paths["/api/v1/results/{requestId}"].get.security).toEqual([{ resultToken: [] }]);
  });

  it("omits disabled services and payment metadata in sandbox development mode", async () => {
    const { app } = buildTestApp({ fetchImpl: routedUpstream([]).impl, disabled: ["competitors"] });
    const doc = await (await fetch((await start(app)) + "/openapi.json")).json();
    expect(doc.paths["/api/v1/competitors"]).toBeUndefined();
    expect(doc.paths["/api/v1/keyword-metrics"].post["x-payment-info"]).toBeUndefined();
    expect((await new Validator().validate(doc)).valid).toBe(true);
  });

  it("lists ownership proofs when configured", async () => {
    const { app } = buildTestApp({ fetchImpl: routedUpstream([]).impl, env: { OWNERSHIP_PROOFS: "0xaaa, 0xbbb" } });
    const doc = await (await fetch((await start(app)) + "/openapi.json")).json();
    expect(doc["x-discovery"]).toEqual({ ownershipProofs: ["0xaaa", "0xbbb"] });
  });

  it("every service's outputExample has the same shape as its real mapped output", () => {
    const fixtures: Record<string, string> = {
      "keyword-metrics": "google-ads-search-volume.json",
      "keyword-ideas": "labs-keyword-suggestions.json",
      "google-serp": "serp-google-organic.json",
      competitors: "labs-competitors-domain.json",
      "search-intent": "labs-search-intent.json",
      "ai-keyword-demand": "ai-keyword-search-volume.json",
      "ranked-keywords": "labs-ranked-keywords.json",
      "keyword-difficulty": "labs-bulk-keyword-difficulty.json",
      "domain-overview": "labs-domain-rank-overview.json",
      "keyword-gap": "labs-domain-intersection.json",
      "google-trends": "keywords-google-trends.json",
      "local-business": "serp-google-maps.json",
      "bing-serp": "serp-bing-organic.json",
      "page-audit": "onpage-instant-pages.json",
      "domain-technologies": "domain-technologies.json",
      "keywords-for-site": "labs-keywords-for-site.json",
      "traffic-estimate": "labs-bulk-traffic-estimation.json",
      "news-search": "serp-google-news.json",
      "image-search": "serp-google-images.json",
      "local-market-check": "serp-google-organic.json",
    };
    const keys = (v: unknown): string[] => {
      const out: string[] = [];
      const walk = (x: unknown, path: string) => {
        if (Array.isArray(x)) return x.forEach((el) => walk(el, path + "[]"));
        // Technology groups/categories are open-ended maps (keys vary per domain): compare only down to the map itself.
        if (path.endsWith(".technologies")) return;
        if (x && typeof x === "object") for (const [k, y] of Object.entries(x)) { out.push(path + "." + k); walk(y, path + "." + k); }
      };
      walk(v, "");
      return [...new Set(out)].sort();
    };
    for (const s of SERVICES) {
      const input = s.inputSchema.parse(s.example);
      const real = s.mapPackage ? s.mapPackage([fixture("serp-google-organic.json").tasks[0], fixture("serp-google-maps.json").tasks[0]], input as never) : s.mapResult(fixture(fixtures[s.id]!).tasks[0], input as never);
      expect(keys(s.outputExample), s.id).toEqual(keys(real));
    }
  });
});

describe("Bazaar discovery metadata and crawler probes", () => {
  it("every 402 carries extensions.bazaar with the example input and output", async () => {
    const { app } = paid();
    const base = await start(app);
    for (const s of SERVICES) {
      const res = await fetch(base + s.route, post(s.example));
      const required = decodePaymentRequiredHeader(res.headers.get("payment-required")!) as unknown as { extensions?: Record<string, any> };
      const info = required.extensions?.bazaar?.info;
      expect(info, s.id).toBeTruthy();
      expect(JSON.stringify(info), s.id).toContain(JSON.stringify(Object.values(s.example as object)[0]).slice(0, 12));
      expect(info.output?.example, s.id).toEqual(s.outputExample);
      expect(required.extensions!.bazaar.schema, s.id).toBeTruthy();
    }
  });

  it("a crawler probe (empty body, no payment) gets the 402 price challenge on every route", async () => {
    const events: Event[] = [];
    const { app } = paid(events);
    const base = await start(app);
    for (const s of SERVICES) {
      for (const probe of [{ method: "POST" }, post({})]) {
        const res = await fetch(base + s.route, probe);
        expect(res.status, s.id).toBe(402);
        const required = decodePaymentRequiredHeader(res.headers.get("payment-required")!);
        expect(required.accepts[0]!.amount, s.id).toBe(String(Math.round(Number(s.priceUsdc) * 1e6)));
      }
    }
    expect(events).toEqual([]);
  });

  it("a non-empty invalid body is still refused immediately (400), and an empty body WITH a payment is never settled", async () => {
    const events: Event[] = [];
    const fac = fakeFacilitator(events);
    const { app } = buildTestApp({ fetchImpl: routedUpstream(events).impl, facilitator: fac });
    const base = await start(app);
    const bad = await fetch(base + "/api/v1/keyword-metrics", post({ keywords: [] }));
    expect(bad.status).toBe(400);
    expect(bad.headers.get("payment-required")).toBeNull();

    // A buyer that pays a request with an empty body: the server answers 400 and nothing is settled.
    const { pay } = buyer();
    const res = await pay(base + "/api/v1/keyword-metrics", post({}));
    expect([400, 402]).toContain(res.status);
    expect(fac.settles()).toBe(0);
    expect(events).toEqual([]);
  });

  it("a payment header with an invalid body is refused with 400 and never settled", async () => {
    const events: Event[] = [];
    const fac = fakeFacilitator(events);
    const { app } = buildTestApp({ fetchImpl: routedUpstream(events).impl, facilitator: fac });
    const base = await start(app);
    const res = await fetch(base + "/api/v1/competitors", post({}, { "payment-signature": Buffer.from(JSON.stringify({ x402Version: 2, accepted: {}, payload: {} })).toString("base64") }));
    expect(res.status).toBe(400);
    expect(fac.settles()).toBe(0);
    expect(events).toEqual([]);
  });
});

describe("website and discovery files", () => {
  it("serves the landing page with all services, prices, MCP/OpenAPI links, status area and strict security headers", async () => {
    const { app } = paid();
    const res = await fetch((await start(app)) + "/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const html = await res.text();
    expect(html).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(html).toContain("Pay-per-call data APIs for AI agents");
    expect(html).toContain('href="/openapi.json"');
    expect(html).toContain("https://agent.example.com/mcp");
    expect(html).toContain('id="status-text"');
    expect(html).toContain("ops@example.com");
    expect(html).toContain("/legal.html#impressum");
    for (const s of SERVICES) {
      expect(html, s.id).toContain(`data-id="${s.id}"`);
      expect(html, s.id).toContain(`${s.priceUsdc} USDC`);
      expect(html, s.id).toContain(toolNameOf(s.id));
    }
    expect(html).toMatch(/estimates/); // AI demand badge
    expect(html).not.toMatch(/<script(?![^>]*src=)/); // no inline scripts
  });

  it("escapes configured text and shows the test-mode note", async () => {
    const { app } = buildTestApp({
      fetchImpl: routedUpstream([]).impl,
      facilitator: fakeFacilitator([]),
      env: { SITE_NAME: "A <b>&\"Name\"", PAYMENT_MODE: "testnet", PAY_TO_ADDRESS: PAY_TO, DATAFORSEO_LOGIN: "l", DATAFORSEO_PASSWORD: "p" },
    });
    const html = await (await fetch((await start(app)) + "/")).text();
    expect(html).not.toContain("<b>&");
    expect(html).toContain("A &lt;b&gt;&amp;&quot;Name&quot;");
    expect(html).toContain("Base Sepolia test USDC");
    expect(render("{{A}} {{b}} {{C_D}}", { A: "1", C_D: "2" })).toBe("1 {{b}} 2");
  });

  it("serves llms.txt, the legal placeholder page (noindex), robots.txt and the compat well-known file", async () => {
    const { app } = paid();
    const base = await start(app);
    const llms = await (await fetch(base + "/llms.txt")).text();
    expect(llms).not.toMatch(/\{\{[A-Z_]+\}\}/);
    for (const s of SERVICES) expect(llms).toContain(`POST https://agent.example.com${s.route}`);
    expect(llms).toContain("https://agent.example.com/openapi.json");
    expect(llms).toMatch(/modeled estimates/);
    expect(llms).toMatch(/businesses only \(B2B\)/);
    expect(llms).toContain("https://agent.example.com/legal.html#terms");

    const legal = await (await fetch(base + "/legal.html")).text();
    expect(legal).toContain('name="robots" content="noindex"');
    expect(legal).toContain("[TODO]");
    expect(legal).toMatch(/Legal notice[\s\S]*Privacy policy[\s\S]*Terms of use/);
    expect(legal).toContain("§ 1 Scope; businesses only");
    expect(legal).toContain("automatically deleted after 30 days"); // must match RETENTION_DAYS default
    expect(legal).toContain("Falkenstein");

    const robots = await (await fetch(base + "/robots.txt")).text();
    expect(robots).toContain("Disallow: /\n"); // sandbox/testnet deployments are not indexable
    expect((await fetch(base + "/")).headers.get("x-robots-tag")).toMatch(/noindex/);

    const wk = await (await fetch(base + "/.well-known/x402")).json();
    expect(wk.version).toBe(1);
    expect(wk.resources).toEqual(SERVICES.map((s) => `https://agent.example.com${s.route}`));
  });

  it("a mainnet deployment is indexable but keeps /admin and /api out of search results", async () => {
    const { app } = buildTestApp({
      fetchImpl: routedUpstream([]).impl,
      facilitator: fakeFacilitator([]),
      env: { NODE_ENV: "production", PAYMENT_MODE: "mainnet", DATAFORSEO_MODE: "live", DATAFORSEO_LOGIN: "l", DATAFORSEO_PASSWORD: "p", PAY_TO_ADDRESS: PAY_TO, PUBLIC_BASE_URL: "https://agent.example.com", ADMIN_PASSWORD: "x".repeat(20), CDP_API_KEY_ID: "i", CDP_API_KEY_SECRET: "s", TRUST_PROXY: "1" },
    });
    const base = await start(app);
    const robots = await (await fetch(base + "/robots.txt")).text();
    expect(robots).toContain("Allow: /");
    expect(robots).toContain("Disallow: /admin");
    expect((await fetch(base + "/")).headers.get("x-robots-tag")).toBeNull();
  });

  it("serves directory verification files only when configured", async () => {
    const off = await start(buildTestApp({ fetchImpl: routedUpstream([]).impl }).app);
    for (const f of ["402index-verify.txt", "mcp-registry-auth", "glama.json"]) expect((await fetch(`${off}/.well-known/${f}`)).status, f).toBe(404);
    const on = await start(
      buildTestApp({
        fetchImpl: routedUpstream([]).impl,
        env: { WELLKNOWN_402INDEX: "abc123hash", WELLKNOWN_MCP_REGISTRY_AUTH: "v=MCPv1; k=ed25519; p=AAAA", WELLKNOWN_GLAMA: '{"claim":"glama_claim_x"}' },
      }).app,
    );
    const a = await fetch(`${on}/.well-known/402index-verify.txt`);
    expect(await a.text()).toBe("abc123hash");
    expect(a.headers.get("content-type")).toMatch(/text\/plain/);
    expect(await (await fetch(`${on}/.well-known/mcp-registry-auth`)).text()).toBe("v=MCPv1; k=ed25519; p=AAAA");
    const g = await fetch(`${on}/.well-known/glama.json`);
    expect(g.headers.get("content-type")).toMatch(/application\/json/);
    expect(await g.json()).toEqual({ claim: "glama_claim_x" });
  });

  it("serves static assets (also from a project path with spaces) and nothing outside public/", async () => {
    const { app } = paid();
    const base = await start(app);
    for (const [f, type] of [["style.css", /text\/css/], ["app.js", /javascript/], ["favicon.svg", /svg/]] as const) {
      const res = await fetch(`${base}/${f}`);
      expect(res.status, f).toBe(200);
      expect(res.headers.get("content-type"), f).toMatch(type);
    }
    for (const bad of ["/.env", "/package.json", "/src/app.ts", "/data/app.db", "/..%2fpackage.json", "/%2e%2e/package.json", "/node_modules/zod/package.json"]) {
      const res = await fetch(base + bad);
      expect(res.status, bad).toBe(404);
    }
  });

  it("the API 404 and JSON routes are unaffected by the site router", async () => {
    const { app } = paid();
    const base = await start(app);
    expect((await fetch(base + "/nope")).status).toBe(404);
    expect((await fetch(base + "/health")).status).toBe(200);
    expect((await fetch(base + "/api/v1/services")).status).toBe(200);
  });
});
