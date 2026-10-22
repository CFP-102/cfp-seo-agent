import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey } from "viem/accounts";
import { buildTestApp, PAY_TO } from "./helpers.js";
import { fakeFacilitator, routedUpstream, SEPOLIA_USDC, start, type Event } from "./x402helpers.js";

const exampleUrl = new URL("../public/examples/buyer.mjs", import.meta.url).href;
const example = () => import(exampleUrl);
const req = { scheme: "exact", network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: PAY_TO, amount: "25000" };

describe("public buyer guide payment safeguards", () => {
  it("refuses changed recipients, amounts, assets, networks, resources and a second authorization", async () => {
    const { paymentGuard } = await example();
    let authorized = 0;
    const guard = paymentGuard({ network: req.network, asset: req.asset, merchant: PAY_TO, amount: req.amount,
      resource: "https://api.example/serp", onAuthorize: () => { authorized++; } });
    const context = (r = req, url = "https://api.example/serp") => ({ selectedRequirements: r, paymentRequired: { resource: { url } } });
    for (const changed of [{ payTo: "0x0000000000000000000000000000000000000001" }, { amount: "25001" }, { network: "eip155:1" }, { asset: "0x0000000000000000000000000000000000000001" }]) {
      await expect(guard(context({ ...req, ...changed }))).rejects.toThrow();
    }
    await expect(guard(context(req, "https://other.example/serp"))).rejects.toThrow();
    expect(authorized).toBe(0);
    await guard(context());
    await expect(guard(context())).rejects.toThrow();
    expect(authorized).toBe(1);
  });

  for (const protocol of ["rest", "mcp"]) {
    it(`${protocol}: preview never pays; approved purchase runs once and cannot silently be bought again`, async () => {
      const events: Event[] = [];
      const fac = fakeFacilitator(events);
      const { app } = buildTestApp({ fetchImpl: routedUpstream(events).impl, facilitator: fac,
        env: { PAYMENT_MODE: "testnet", DATAFORSEO_MODE: "live", ALLOW_LIVE_DATA_ON_TESTNET: "true", DATAFORSEO_LOGIN: "test", DATAFORSEO_PASSWORD: "test", PAY_TO_ADDRESS: PAY_TO } });
      const baseUrl = await start(app);
      const journal = join(mkdtempSync(join(tmpdir(), "buyer-guide-")), "purchase.json");
      const { runBuyer } = await example();
      const key = generatePrivateKey();
      const options = { baseUrl, protocol, journal, key, merchant: PAY_TO, network: "eip155:84532", asset: SEPOLIA_USDC,
        resourceUrl: protocol === "rest" ? "http://api.test/api/v1/google-serp" : "mcp://tool/google_serp" };
      expect(await runBuyer({ ...options, approval: "0" })).toMatchObject({ paid: false });
      expect(events).toEqual([]);
      await expect(runBuyer({ ...options, approval: "0.001" })).rejects.toThrow();
      expect(events).toEqual([]);
      await runBuyer({ ...options, approval: "0.025" });
      expect(events).toEqual(["settle", "upstream"]);
      expect(fac.settles()).toBe(1);
      expect(readFileSync(journal, "utf8")).not.toContain(key);
      expect(statSync(journal).mode & 0o777).toBe(0o600);
      await expect(runBuyer({ ...options, approval: "0.025" })).rejects.toThrow();
      expect(fac.settles()).toBe(1);
    });
  }

  it("preserves an uncertain paid attempt when the response is lost and blocks a replacement purchase", async () => {
    const events: Event[] = [];
    const fac = fakeFacilitator(events);
    const { app } = buildTestApp({ fetchImpl: routedUpstream(events).impl, facilitator: fac,
      env: { PAYMENT_MODE: "testnet", DATAFORSEO_MODE: "live", ALLOW_LIVE_DATA_ON_TESTNET: "true", DATAFORSEO_LOGIN: "test", DATAFORSEO_PASSWORD: "test", PAY_TO_ADDRESS: PAY_TO } });
    const baseUrl = await start(app);
    const journal = join(mkdtempSync(join(tmpdir(), "buyer-guide-lost-")), "purchase.json");
    const { runBuyer } = await example();
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const response = await fetch(request);
      if (request.headers.has("payment-signature")) throw Error("Simulated response loss after settlement");
      return response;
    };
    const options = { baseUrl, journal, key: generatePrivateKey(), merchant: PAY_TO, network: "eip155:84532",
      asset: SEPOLIA_USDC, approval: "0.025", protocol: "rest", resourceUrl: "http://api.test/api/v1/google-serp", fetchImpl };
    await expect(runBuyer(options)).rejects.toThrow();
    expect(JSON.parse(readFileSync(journal, "utf8")).status).toBe("stopped_check_payment_before_retry");
    expect(events).toEqual(["settle", "upstream"]);
    await expect(runBuyer(options)).rejects.toThrow();
    expect(fac.settles()).toBe(1);
    expect(events).toEqual(["settle", "upstream"]);
  });
});
