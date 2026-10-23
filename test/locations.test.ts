import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildTestApp } from "./helpers.js";
import { buyer, fakeFacilitator, post, routedUpstream, start, type Event } from "./x402helpers.js";
import { checkLocale, defaultLanguage, searchDachLocations } from "../src/config/locales.js";
import { SERP_FAMILY } from "../src/app.js";
import { SERVICES } from "../src/services/index.js";

const ROSENHEIM = 1004269;

describe("DACH city/region locations", () => {
  it("finds Rosenheim and defaults to German", () => {
    const hit = searchDachLocations("rosenheim", "DE");
    expect(hit[0]).toMatchObject({ location_code: ROSENHEIM, type: "City", country_iso_code: "DE" });
    expect(defaultLanguage(ROSENHEIM)).toBe("de");
    expect(searchDachLocations("wien").some((l) => l.country_iso_code === "AT")).toBe(true);
    expect(searchDachLocations("München")[0]!.name).toMatch(/^Munich/);
    expect(searchDachLocations("Düsseldorf")[0]!.name).toMatch(/^Dusseldorf/);
    expect(searchDachLocations("köln")[0]!.name).toMatch(/^Cologne/);
  });

  it("city codes pass only for the Google SERP family; other families get a clear refusal", () => {
    expect(checkLocale("serp", ROSENHEIM, "de")).toBeNull();
    expect(checkLocale("labs", ROSENHEIM, "de")).toMatch(/country-level codes only/);
    expect(checkLocale("google_ads", ROSENHEIM, "de")).toMatch(/2276/);
    for (const s of SERVICES) {
      const example = { ...(s.example as object), location_code: ROSENHEIM, language_code: "de" };
      const parsed = s.inputSchema.safeParse(example);
      if (!parsed.success || !s.validateInput) continue;
      const ok = s.validateInput(parsed.data) === null;
      expect(ok, s.id).toBe(SERP_FAMILY.includes(s.id));
    }
  });

  it("free REST lookup and MCP tool; a paid SERP call with a city code is accepted and sent upstream unchanged", async () => {
    const events: Event[] = [];
    const up = routedUpstream(events);
    const { app } = buildTestApp({ fetchImpl: up.impl, facilitator: fakeFacilitator(events) });
    const base = await start(app);
    const res = await (await fetch(base + "/api/v1/locations?q=rosenheim&country=DE")).json();
    expect(res.locations[0].location_code).toBe(ROSENHEIM);
    expect((await fetch(base + "/api/v1/locations?q=a")).status).toBe(400);
    const c = new Client({ name: "t", version: "1" });
    await c.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp")));
    const out = await c.callTool({ name: "find_location", arguments: { query: "zürich" } });
    expect(JSON.stringify(out.content)).toContain("CH");
    await c.close();
    const { pay } = buyer();
    const paid = await pay(base + "/api/v1/local-market-check", post({ keyword: "zahnarzt", location_code: ROSENHEIM }));
    expect(paid.status).toBe(200);
    expect(up.calls.every((x) => (x.body as any[])[0].location_code === ROSENHEIM && (x.body as any[])[0].language_code === "de")).toBe(true);
    // Labs service with a city code: refused before any 402.
    const labs = await fetch(base + "/api/v1/competitors", post({ domain: "example.com", location_code: ROSENHEIM }));
    expect(labs.status).toBe(422);
    expect(labs.headers.get("payment-required")).toBeNull();
  });
});
