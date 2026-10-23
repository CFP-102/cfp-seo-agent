import { describe, expect, it } from "vitest";
import { buildTestApp } from "./helpers.js";
import { routedUpstream } from "./x402helpers.js";
import { createAlerts, smtpSender } from "../src/lib/alerts.js";
import { loadEnv } from "../src/config/env.js";

describe("e-mail alerts", () => {
  it("are off unless fully configured", () => {
    expect(smtpSender(loadEnv({ NODE_ENV: "test" }))).toBeNull();
    expect(smtpSender(loadEnv({ NODE_ENV: "test", ALERT_EMAIL_TO: "a@example.com", SMTP_HOST: "smtp.example.com", SMTP_USER: "u" }))).toBeNull();
    expect(smtpSender(loadEnv({ NODE_ENV: "test", ALERT_EMAIL_TO: "a@example.com", SMTP_HOST: "smtp.example.com", SMTP_USER: "u", SMTP_PASSWORD: "p" }))).not.toBeNull();
  });

  it("warns once per budget level, reports new problem payments once, sends one daily summary", async () => {
    const { store, pipeline, env } = buildTestApp({ fetchImpl: routedUpstream([]).impl }) as any;
    const mails: { subject: string; text: string }[] = [];
    let now = new Date();
    now.setUTCHours(6, 0, 0, 0);
    const a = createAlerts({ env, store, pipeline, send: async (subject, text) => void mails.push({ subject, text }), now: () => now });
    await a.check();
    expect(mails).toHaveLength(0);
    // 85 % of the $5 daily budget spent (live data counts).
    store.claim({ id: "b1", service_id: "keyword-metrics", data_source: "live", price_usdc: 0.12, payment_key: "kb1", network: "eip155:8453", payer: "0xP", input_hash: "h", input_json: "{}", result_token_hash: "t" });
    store.setSettled("b1", "0xt1", "0xP");
    store.complete("b1", { resultJson: "{}", upstreamCostUsd: 4.25, cacheHit: false });
    await a.check();
    await a.check();
    expect(mails.filter((m) => /Tagesbudget bei 85/.test(m.subject))).toHaveLength(1);
    // A paid request fails after settlement.
    store.claim({ id: "b2", service_id: "google-serp", data_source: "live", price_usdc: 0.025, payment_key: "kb2", network: "eip155:8453", payer: "0xP", input_hash: "h", input_json: "{}", result_token_hash: "t" });
    store.setSettled("b2", "0xt2", "0xP");
    store.fail("b2", "50000", 0);
    await a.check();
    await a.check();
    const att = mails.filter((m) => /Aufmerksamkeit/.test(m.subject));
    expect(att).toHaveLength(1);
    expect(att[0]!.text).toContain("b2");
    // Daily summary after 07:00 UTC, once.
    now = new Date(now.getTime() + 2 * 3600_000);
    await a.check();
    await a.check();
    expect(mails.filter((m) => /Tagesbericht/.test(m.subject))).toHaveLength(1);
  });

  it("retries a mail that failed to send", async () => {
    const { store, pipeline, env } = buildTestApp({ fetchImpl: routedUpstream([]).impl }) as any;
    let fail = true;
    let delivered = 0;
    const now = new Date();
    now.setUTCHours(8, 0, 0, 0);
    const a = createAlerts({ env, store, pipeline, now: () => now, send: async () => { if (fail) throw new Error("smtp down"); delivered++; } });
    await a.check(); // summary fails
    fail = false;
    await a.check();
    expect(delivered).toBe(1);
  });
});
