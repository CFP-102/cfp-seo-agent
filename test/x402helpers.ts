/**
 * Shared helpers for the x402 integration tests: a simulated facilitator (enforces single-use nonces like the
 * USDC contract), a fake DataForSEO upstream that logs into the same event list, and a real @x402/fetch buyer.
 */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach } from "vitest";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import type { FacilitatorClient } from "@x402/core/server";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { buildTestApp, fakeFetch, fixture } from "./helpers.js";

export const SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

export type Event = string;

export function fakeFacilitator(events: Event[], opts: { failSettle?: boolean; settleDelayMs?: number } = {}) {
  const usedNonces = new Set<string>();
  let settles = 0;
  const f: FacilitatorClient & { settles: () => number } = {
    settles: () => settles,
    async getSupported() {
      return { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:84532" }], extensions: [], signers: {} };
    },
    async verify(payload, req) {
      const auth = (payload.payload as { authorization: { from: string; to: string; value: string; nonce: string } }).authorization;
      events.push("verify");
      if (auth.to.toLowerCase() !== req.payTo.toLowerCase() || auth.value !== req.amount) return { isValid: false, invalidReason: "invalid_exact_evm_payload" };
      return { isValid: true, payer: auth.from };
    },
    async settle(payload, req) {
      const auth = (payload.payload as { authorization: { from: string; nonce: string } }).authorization;
      events.push("settle");
      if (opts.settleDelayMs) await new Promise((r) => setTimeout(r, opts.settleDelayMs));
      if (opts.failSettle) return { success: false, errorReason: "insufficient_funds", transaction: "", network: req.network };
      if (usedNonces.has(auth.nonce)) return { success: false, errorReason: "invalid_exact_evm_nonce_already_used", transaction: "", network: req.network };
      usedNonces.add(auth.nonce);
      settles++;
      return { success: true, transaction: `0x${"ab".repeat(31)}${String(settles).padStart(2, "0")}`, network: req.network, payer: auth.from };
    },
  };
  return f;
}

/** Upstream fetch that logs into the shared event list, so we can assert settle-before-upstream. */
export function upstream(events: Event[], bodies: unknown[] = [fixture("google-ads-search-volume.json")]) {
  let i = 0;
  const ff = fakeFetch(() => {
    events.push("upstream");
    return bodies[Math.min(i++, bodies.length - 1)];
  });
  return ff;
}

const servers: Server[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));

export async function start(app: ReturnType<typeof buildTestApp>["app"]) {
  const server = app.listen(0);
  servers.push(server);
  await new Promise((r) => server.once("listening", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

export function buyer() {
  const client = new x402Client();
  registerExactEvmScheme(client, { signer: privateKeyToAccount(generatePrivateKey()) });
  const sent: Headers[] = [];
  const recording = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    sent.push(new Headers(req.headers));
    return fetch(req);
  }) as typeof fetch;
  return { pay: wrapFetchWithPayment(recording, client), sent };
}

export const post = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});


export const FIXTURE_BY_ENDPOINT: Record<string, string> = {
  "/v3/keywords_data/google_ads/search_volume/live": "google-ads-search-volume.json",
  "/v3/dataforseo_labs/google/keyword_suggestions/live": "labs-keyword-suggestions.json",
  "/v3/serp/google/organic/live/advanced": "serp-google-organic.json",
  "/v3/dataforseo_labs/google/competitors_domain/live": "labs-competitors-domain.json",
  "/v3/dataforseo_labs/google/search_intent/live": "labs-search-intent.json",
  "/v3/ai_optimization/ai_keyword_data/keywords_search_volume/live": "ai-keyword-search-volume.json",
  "/v3/dataforseo_labs/google/ranked_keywords/live": "labs-ranked-keywords.json",
  "/v3/dataforseo_labs/google/bulk_keyword_difficulty/live": "labs-bulk-keyword-difficulty.json",
  "/v3/dataforseo_labs/google/domain_rank_overview/live": "labs-domain-rank-overview.json",
  "/v3/dataforseo_labs/google/domain_intersection/live": "labs-domain-intersection.json",
  "/v3/keywords_data/google_trends/explore/live": "keywords-google-trends.json",
  "/v3/serp/google/maps/live/advanced": "serp-google-maps.json",
  "/v3/serp/bing/organic/live/advanced": "serp-bing-organic.json",
  "/v3/on_page/instant_pages": "onpage-instant-pages.json",
  "/v3/domain_analytics/technologies/domain_technologies/live": "domain-technologies.json",
  "/v3/dataforseo_labs/google/keywords_for_site/live": "labs-keywords-for-site.json",
  "/v3/dataforseo_labs/google/bulk_traffic_estimation/live": "labs-bulk-traffic-estimation.json",
  "/v3/serp/google/news/live/advanced": "serp-google-news.json",
  "/v3/on_page/content_parsing/live": "onpage-content-parsing.json",
  "/v3/serp/google/images/live/advanced": "serp-google-images.json",
};

export function routedUpstream(events: Event[]) {
  const calls: { endpoint: string; body: unknown }[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    const endpoint = new URL(String(url)).pathname;
    calls.push({ endpoint, body: JSON.parse(String(init?.body)) });
    events.push("upstream");
    const file = FIXTURE_BY_ENDPOINT[endpoint];
    if (!file) return new Response(JSON.stringify({ status_code: 40402, status_message: "Invalid Path", cost: 0, tasks: [] }));
    return new Response(JSON.stringify(fixture(file)), { headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

