/**
 * Central commercial configuration for every service.
 * Change prices, limits, cost ceilings, cache TTLs or switch a service off here.
 * A service can also be switched off at runtime without a rebuild via
 * DISABLED_SERVICES=keyword-ideas,competitors in .env.
 *
 * Upstream prices below are DataForSEO list prices (Live mode) as published on
 * dataforseo.com/pricing, checked 2026-10-20. Re-check them before changing limits.
 *
 * Pricing: fixed prices per call, set just below the comparable ConnSkill endpoint
 * (agent.connskill.com/.well-known/x402, checked 2026-10-20) and always above our
 * worst-case DataForSEO cost plus the facilitator fee (enforced by tests and at startup).
 */

/** CDP facilitator: first 1,000 settlements/month free, then $0.001 each (gas included). */
export const FACILITATOR_FEE_USD = 0.001;

export interface ServiceConfig {
  id: string;
  name: string;
  route: string;
  /** Worst-case DataForSEO list price for one request at maxInputs/maxResults. */
  worstCaseUsd: number;
  /** Selling price per request in USDC (decimal string, sent as-is to x402). */
  priceUsdc: string;
  /** Comparable market price (ConnSkill) we stay below; null if there is no comparable endpoint. */
  referencePriceUsdc: string | null;
  enabled: boolean;
  /** Max items the caller may send (keywords, domains, ...). */
  maxInputs: number;
  /** Max items we return (and request from DataForSEO via limit/depth). */
  maxResults: number;
  dataforseoEndpoint: string;
  /** Hard ceiling for one upstream call; requests whose worst-case estimate exceeds this are refused before payment. */
  maxUpstreamCostUsd: number;
  cacheTtlSeconds: number;
  /** Upstream calls per minute we allow ourselves for this endpoint (DataForSEO account-wide limits apply). */
  upstreamPerMinute: number;
}

export const DFS_PRICES = {
  /** Google Ads search_volume Live: flat per task, independent of keyword count. */
  googleAdsLivePerTask: 0.09,
  /** DataForSEO Labs: per task + per returned item. */
  labsPerTask: 0.012,
  labsPerItem: 0.00012,
  /** SERP Google Organic Live: per 10-result page. */
  serpLivePerPage: 0.002,
  /** AI Optimization keyword search volume: per task + per keyword. */
  aiKeywordPerTask: 0.01,
  aiKeywordPerItem: 0.0001,
} as const;

const labs = (items: number) => DFS_PRICES.labsPerTask + items * DFS_PRICES.labsPerItem;

export const SERVICE_CONFIG: Record<string, ServiceConfig> = {
  "keyword-metrics": {
    id: "keyword-metrics",
    name: "Keyword Metrics",
    route: "/api/v1/keyword-metrics",
    worstCaseUsd: DFS_PRICES.googleAdsLivePerTask,
    priceUsdc: "0.12",
    referencePriceUsdc: "0.15",
    enabled: true,
    // DataForSEO accepts up to 1000 keywords per task at the same flat price.
    maxInputs: 1000,
    maxResults: 1000,
    dataforseoEndpoint: "/v3/keywords_data/google_ads/search_volume/live",
    // Google Ads Live is a flat $0.09/task: thinnest margin of all services. See docs/DATAFORSEO.md "Preise".
    maxUpstreamCostUsd: 0.1,
    cacheTtlSeconds: 24 * 3600,
    // DataForSEO limits Google Ads Live to 12 requests/minute per account.
    upstreamPerMinute: 10,
  },
  "keyword-ideas": {
    id: "keyword-ideas",
    name: "Keyword Ideas",
    route: "/api/v1/keyword-ideas",
    worstCaseUsd: labs(25),
    priceUsdc: "0.025",
    referencePriceUsdc: "0.03",
    enabled: true,
    maxInputs: 1,
    maxResults: 25,
    dataforseoEndpoint: "/v3/dataforseo_labs/google/keyword_suggestions/live",
    maxUpstreamCostUsd: 0.03,
    cacheTtlSeconds: 24 * 3600,
    upstreamPerMinute: 60,
  },
  "google-serp": {
    id: "google-serp",
    name: "Google SERP",
    route: "/api/v1/google-serp",
    worstCaseUsd: DFS_PRICES.serpLivePerPage,
    priceUsdc: "0.025",
    referencePriceUsdc: "0.03",
    enabled: true,
    maxInputs: 1,
    maxResults: 10,
    dataforseoEndpoint: "/v3/serp/google/organic/live/advanced",
    // Worst case assumes search operators (site:, intitle:, ... cost x5) are rejected by the adapter (phase 3).
    maxUpstreamCostUsd: 0.015,
    cacheTtlSeconds: 6 * 3600,
    upstreamPerMinute: 60,
  },
  competitors: {
    id: "competitors",
    name: "Competitor Discovery",
    route: "/api/v1/competitors",
    worstCaseUsd: labs(10),
    priceUsdc: "0.04",
    referencePriceUsdc: "0.05",
    enabled: true,
    maxInputs: 1,
    maxResults: 10,
    dataforseoEndpoint: "/v3/dataforseo_labs/google/competitors_domain/live",
    maxUpstreamCostUsd: 0.03,
    cacheTtlSeconds: 7 * 24 * 3600,
    upstreamPerMinute: 60,
  },
  "ranked-keywords": {
    id: "ranked-keywords",
    name: "Ranked Keywords",
    route: "/api/v1/ranked-keywords",
    worstCaseUsd: labs(25),
    priceUsdc: "0.04",
    referencePriceUsdc: "0.05",
    enabled: true,
    maxInputs: 1,
    maxResults: 25,
    dataforseoEndpoint: "/v3/dataforseo_labs/google/ranked_keywords/live",
    maxUpstreamCostUsd: 0.03,
    cacheTtlSeconds: 24 * 3600,
    upstreamPerMinute: 60,
  },
  "keyword-difficulty": {
    id: "keyword-difficulty",
    name: "Keyword Difficulty",
    route: "/api/v1/keyword-difficulty",
    worstCaseUsd: labs(100),
    priceUsdc: "0.04",
    referencePriceUsdc: "0.05",
    enabled: true,
    maxInputs: 100,
    maxResults: 100,
    dataforseoEndpoint: "/v3/dataforseo_labs/google/bulk_keyword_difficulty/live",
    maxUpstreamCostUsd: 0.03,
    cacheTtlSeconds: 7 * 24 * 3600,
    upstreamPerMinute: 60,
  },
  "domain-overview": {
    id: "domain-overview",
    name: "Domain Overview",
    route: "/api/v1/domain-overview",
    worstCaseUsd: labs(1),
    priceUsdc: "0.04",
    referencePriceUsdc: "0.05",
    enabled: true,
    maxInputs: 1,
    maxResults: 1,
    dataforseoEndpoint: "/v3/dataforseo_labs/google/domain_rank_overview/live",
    maxUpstreamCostUsd: 0.03,
    cacheTtlSeconds: 24 * 3600,
    upstreamPerMinute: 60,
  },
  "search-intent": {
    id: "search-intent",
    name: "Search Intent",
    route: "/api/v1/search-intent",
    worstCaseUsd: labs(10),
    priceUsdc: "0.04",
    // No ConnSkill equivalent; their closest Labs-based endpoint (keyword-difficulty) is 0.05.
    referencePriceUsdc: null,
    enabled: true,
    maxInputs: 10,
    maxResults: 10,
    dataforseoEndpoint: "/v3/dataforseo_labs/google/search_intent/live",
    maxUpstreamCostUsd: 0.03,
    cacheTtlSeconds: 7 * 24 * 3600,
    upstreamPerMinute: 60,
  },
  "ai-keyword-demand": {
    id: "ai-keyword-demand",
    name: "AI Keyword Demand",
    route: "/api/v1/ai-keyword-demand",
    worstCaseUsd: DFS_PRICES.aiKeywordPerTask + 10 * DFS_PRICES.aiKeywordPerItem,
    priceUsdc: "0.04",
    referencePriceUsdc: "0.05",
    enabled: true,
    maxInputs: 10,
    maxResults: 10,
    dataforseoEndpoint: "/v3/ai_optimization/ai_keyword_data/keywords_search_volume/live",
    maxUpstreamCostUsd: 0.03,
    cacheTtlSeconds: 7 * 24 * 3600,
    upstreamPerMinute: 60,
  },
};

export function serviceConfig(id: string): ServiceConfig {
  const c = SERVICE_CONFIG[id];
  if (!c) throw new Error(`unknown service ${id}`);
  return c;
}
