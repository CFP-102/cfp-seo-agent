import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { webcrypto } from "node:crypto";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { buildTestApp, PAY_TO } from "./helpers.js";
import { fakeFacilitator, post, routedUpstream, start, type Event } from "./x402helpers.js";

/** Load the browser script in a sandbox (no DOM): it only exposes window.AgenturPay. */
function loadPay() {
  const window: Record<string, any> = {};
  runInNewContext(readFileSync(new URL("../public/agentur.js", import.meta.url), "utf8"), { window, TextEncoder, TextDecoder, btoa, atob, URL, console });
  return window.AgenturPay as { buildPayment: (...a: any[]) => Promise<{ header: string; amountUsdc: number } | null> };
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
