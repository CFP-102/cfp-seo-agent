import { readFileSync } from "node:fs";
import { createApp } from "../src/app.js";
import { createPayments } from "../src/payments/x402.js";
import type { FacilitatorClient } from "@x402/core/server";
import { SERVICES } from "../src/services/index.js";
import { loadEnv } from "../src/config/env.js";
import { createDataForSeoClient } from "../src/dataforseo/client.js";
import { CostGuard } from "../src/lib/costGuard.js";
import { Store } from "../src/lib/store.js";
import { Pipeline } from "../src/services/pipeline.js";
import { setLogLevel } from "../src/lib/log.js";

setLogLevel("error");

export const PAY_TO = "0xe6a2dddb4c395a393e6035d7194119f62c969fad";

export const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

/** Fake fetch that records calls and returns a queued or fixed JSON body. */
export function fakeFetch(body: unknown | (() => unknown), opts: { delayMs?: number; status?: number } = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    const payload = typeof body === "function" ? (body as () => unknown)() : body;
    return new Response(JSON.stringify(payload), { status: opts.status ?? 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

export function buildTestApp(opts: {
  fetchImpl: typeof fetch;
  env?: Record<string, string>;
  dailyUsd?: number;
  countSpend?: boolean;
  /** Enable x402 (testnet network) against the given facilitator. */
  facilitator?: FacilitatorClient;
  disabled?: string[];
}) {
  const env = loadEnv({ NODE_ENV: "test", DB_PATH: ":memory:", RATE_LIMIT_PER_MINUTE: "1000", ...opts.env });
  const store = new Store(":memory:");
  const dfs = createDataForSeoClient({ mode: env.DATAFORSEO_MODE, login: "test-login", password: "test-password", timeoutMs: 2000, fetchImpl: opts.fetchImpl });
  const guard = new CostGuard(store, { dailyUsd: opts.dailyUsd ?? 5, monthlyUsd: 100, countSpend: opts.countSpend ?? false });
  const pipeline = new Pipeline({ dfs, store, guard, services: SERVICES, disabledServices: opts.disabled });
  const payments = opts.facilitator
    ? createPayments({ mode: "testnet", payTo: PAY_TO, publicBaseUrl: "http://api.test", facilitator: opts.facilitator }, { store, pipeline, services: SERVICES })
    : undefined;
  const app = createApp({ env, store, pipeline, payments });
  return { app, store, pipeline, guard, env };
}
