import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { webcrypto } from "node:crypto";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { buildTestApp, PAY_TO } from "./helpers.js";
import { fakeFacilitator, post, routedUpstream, start, type Event } from "./x402helpers.js";
import { SERVICES } from "../src/services/index.js";

/** Load the browser script in a sandbox (no DOM): it only exposes window.AgenturPay. */
function loadPay() {
  const window: Record<string, any> = {};
  runInNewContext(readFileSync(new URL("../public/agentur.js", import.meta.url), "utf8"), { window, TextEncoder, TextDecoder, btoa, atob, URL, console });
  return window.AgenturPay as {
    buildPayment: (...a: any[]) => Promise<{ header: string; amountUsdc: number } | null>;
    usesJsonEditor: (service: unknown) => boolean;
    usesLocale: (service: unknown) => boolean;
    parseJsonInput: (text: string) => Record<string, unknown>;
    exampleInput: (service: unknown, language: string) => Record<string, unknown>;
  };
}

const walletOf = (account: ReturnType<typeof privateKeyToAccount>) => ({
  address: account.address.toLowerCase(), // wallets often return lowercase addresses
  signTypedData: async (json: string) => {
    const t = JSON.parse(json);
    const { EIP712Domain: _d, ...types } = t.types;
    return account.signTypedData({ domain: t.domain, types, primaryType: t.primaryType, message: t.message });
  },
});

describe("agency page browser payment", () => {
  it("preserves typed content input and buys a local plan through the existing browser payment flow", async () => {
    const events: Event[] = [];
    const { app } = buildTestApp({ fetchImpl: routedUpstream(events).impl, facilitator: fakeFacilitator(events) });
    const base = await start(app);
    const pay = loadPay();
    const catalog = await (await fetch(base + "/api/v1/services")).json();
    for (const entry of catalog.services.filter((s: { category: string }) => s.category === "content")) {
      const service = SERVICES.find(s => s.id === entry.id)!;
      expect(pay.usesJsonEditor(entry)).toBe(true);
      for (const language of ["de", "en"]) {
        const input = pay.parseJsonInput(JSON.stringify(pay.exampleInput(entry, language)));
        expect(service.inputSchema.safeParse(input).success, service.id).toBe(true);
        expect(input).not.toHaveProperty("location_code");
        if (entry.id === "shoot-location-check") expect(input).not.toHaveProperty("language");
        else expect(input.language).toBe(language);
      }
    }
    for (const raw of ["{bad", "null", "[]", '"hello"', " ".repeat(131073)]) expect(() => pay.parseJsonInput(raw)).toThrow();
    expect(pay.usesLocale({ example_request: { keywords: ["seo"] } })).toBe(false);
    expect(pay.usesLocale({ example_request: { keywords: ["seo"], location_code: 2276 } })).toBe(true);
    const service = SERVICES.find(s => s.id === "content-month-plan")!;
    const input = pay.parseJsonInput(JSON.stringify(service.example));
    expect((await fetch(base + "/api/v1/preflight/" + service.id, post(input))).status).toBe(200);
    const quote = await fetch(base + service.route, post(input));
    expect(quote.status).toBe(402);
    const payment = (await pay.buildPayment(quote.headers.get("payment-required"), { payTo: PAY_TO, network: "eip155:84532", priceUsdc: service.priceUsdc }, walletOf(privateKeyToAccount(generatePrivateKey())), Math.floor(Date.now() / 1000), webcrypto, async () => true))!;
    const result = await fetch(base + service.route, { ...post(input), headers: { "content-type": "application/json", "payment-signature": payment.header } });
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ data_source: "local", service: service.id });
    expect(events).toEqual(["settle"]);
  });

  it("builds a valid x402 payment from a wallet signature and buys exactly one call", async () => {
    const events: Event[] = [];
    const { app } = buildTestApp({ fetchImpl: routedUpstream(events).impl, facilitator: fakeFacilitator(events) });
    const base = await start(app);
    const pay = loadPay();
    const quote = await fetch(base + "/api/v1/google-serp", post({ keyword: "coffee" }));
    expect(quote.status).toBe(402);
    const account = privateKeyToAccount(generatePrivateKey());
    let confirmedBeforeSign = false;
    const wallet = walletOf(account);
    const signing = { ...wallet, signTypedData: async (j: string) => { expect(confirmedBeforeSign).toBe(true); return wallet.signTypedData(j); } };
    const p = (await pay.buildPayment(quote.headers.get("payment-required"), { payTo: PAY_TO, network: "eip155:84532", priceUsdc: "0.025" }, signing, Math.floor(Date.now() / 1000), webcrypto, async () => (confirmedBeforeSign = true)))!;
    const declined = await pay.buildPayment(quote.headers.get("payment-required"), { payTo: PAY_TO, network: "eip155:84532", priceUsdc: "0.025" }, { address: "0x1", signTypedData: async () => { throw new Error("must not sign"); } }, 0, webcrypto, async () => false);
    expect(declined).toBeNull();
    expect(p.amountUsdc).toBe(0.025);
    const res = await fetch(base + "/api/v1/google-serp", { ...post({ keyword: "coffee" }), headers: { "content-type": "application/json", "payment-signature": p.header } });
    expect(res.status).toBe(200);
    expect(events).toEqual(["settle", "upstream"]);
  });

  it("refuses to sign when the quote does not match recipient, price or currency", async () => {
    const { app } = buildTestApp({ fetchImpl: routedUpstream([]).impl, facilitator: fakeFacilitator([]) });
    const base = await start(app);
    const pay = loadPay();
    const header = (await fetch(base + "/api/v1/google-serp", post({ keyword: "coffee" }))).headers.get("payment-required");
    let signed = 0;
    const wallet = { address: "0x0000000000000000000000000000000000000001", signTypedData: async () => (signed++, "0x") };
    await expect(pay.buildPayment(header, { payTo: "0x000000000000000000000000000000000000dEaD", network: "eip155:84532", priceUsdc: "0.025" }, wallet, 0, webcrypto)).rejects.toThrow(/Empfänger/);
    await expect(pay.buildPayment(header, { payTo: PAY_TO, network: "eip155:84532", priceUsdc: "0.02" }, wallet, 0, webcrypto)).rejects.toThrow(/Preis/);
    await expect(pay.buildPayment(header, { payTo: PAY_TO, network: "eip155:8453", priceUsdc: "0.025" }, wallet, 0, webcrypto)).rejects.toThrow(/Zahlungsart/);
    expect(signed).toBe(0);
  });

  it("serves the German agency page with the operator address and only same-origin scripts", async () => {
    const { app } = buildTestApp({ fetchImpl: routedUpstream([]).impl, facilitator: fakeFacilitator([]), env: { PAY_TO_ADDRESS: PAY_TO } });
    const base = await start(app);
    const res = await fetch(base + "/de/agenturen");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
    const html = await res.text();
    expect(html).toContain(`data-pay-to="${PAY_TO}"`);
    expect(html).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(html).toMatch(/<script src="\/agentur.js" defer><\/script>/);
    expect(readFileSync(new URL("../public/agentur.js", import.meta.url), "utf8")).not.toMatch(/innerHTML|eval\(|new Function/);
    const en = await (await fetch(base + "/agencies")).text();
    expect(en).toContain('<html lang="en">');
    expect(en).toContain("No subscription");
    expect(en).toContain('href="/de/agenturen" hreflang="de"');
    expect(en).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(html).toContain("Brauche ich ein Konto");
  });
});
