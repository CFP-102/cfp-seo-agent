import { describe, expect, it } from "vitest";
import { buildTestApp, fixture } from "./helpers.js";
import { buyer, fakeFacilitator, post, routedUpstream, start, type Event } from "./x402helpers.js";
import { localMarketCheck } from "../src/services/localMarketCheck.js";

const tasks = () => [fixture("serp-google-organic.json").tasks[0], fixture("serp-google-maps.json").tasks[0]];

describe("local-market-check package", () => {
  it("combines organic and Maps results, competitor domains and observations; checks your domain only within the sample", () => {
    const i = localMarketCheck.inputSchema.parse({ keyword: "pizza london", domain: "www.tripadvisor.com" });
    const out = localMarketCheck.mapPackage!(tasks(), i);
    expect(out.organic.length).toBeGreaterThan(0);
    expect(out.organic.length).toBeLessThanOrEqual(10);
    expect(out.maps.length).toBeLessThanOrEqual(10);
    expect(out.your_domain?.domain).toBe("tripadvisor.com");
    expect(out.competitor_domains.some((d) => d.domain === "tripadvisor.com")).toBe(false);
    expect(out.observations.length).toBeGreaterThan(0);
    expect(localMarketCheck.estimateCostUsd(i)).toBeLessThanOrEqual(localMarketCheck.upstream.maxCostUsd);
    expect(localMarketCheck.inputSchema.safeParse({ keyword: "site:example.com" }).success).toBe(false);
  });

  it("one payment: both steps are called once; if one step fails the call fails, all charged costs are booked and the free retry is offered", async () => {
    const events: Event[] = [];
    const base = routedUpstream(events);
    const failingMaps = (async (url: string | URL, init?: RequestInit) => {
      if (String(url).includes("/serp/google/maps/")) {
        events.push("upstream");
        return new Response(JSON.stringify({ status_code: 20000, cost: 0.002, tasks: [{ status_code: 40501, status_message: "Invalid Field", cost: 0.002 }] }));
      }
      return base.impl(url, init);
    }) as unknown as typeof fetch;
    const { app, store } = buildTestApp({ fetchImpl: failingMaps, facilitator: fakeFacilitator(events) });
    const srv = await start(app);
    const { pay } = buyer();
    const res = await pay(srv + "/api/v1/local-market-check", post({ keyword: "pizza london" }));
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(422); // provider rejected the step (40501)
    expect(body.retry_available).toBe(true);
    expect(events).toEqual(["settle", "upstream", "upstream"]);
    const row = store.get(body.request_id)!;
    expect(row.status).toBe("failed");
    expect(row.upstream_cost_usd).toBeGreaterThanOrEqual(0.002);
  });
});
