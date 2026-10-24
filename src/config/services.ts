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
  /** Website grouping: "data" (default, SEO and open data) or "content" (content planning for agencies and video teams). */
  category?: ServiceCategory;
}

export type ServiceCategory = "data" | "content";

/** Bounded website extraction and regional dataset limits, shared by validation and mapping. */
export const CONTENT_LIMITS = { textChars: 12000, headings: 40, headingChars: 200, links: 40, urlChars: 2000, changes: 40 } as const;
export const WEBSITE_CHECK_LIMITS = { links: 2, requests: 4, timeoutMs: 8000, sitemapBytes: 65536, headerBytes: 16384, headerValueChars: 200 } as const;
export const CATALOG_LIMITS = { queryChars: 80, results: 10, resources: 3, urls: 2, titleChars: 200, descriptionChars: 500, fieldChars: 300, idChars: 200, responseBytes: 2097152, timeoutMs: 10000 } as const;
export const CATALOG_SOURCES = { govdata: "https://ckan.govdata.de/api/3/action/package_search", openbydata: "https://open.bydata.de/api/hub/search/search" } as const;
/** Content planning services (shoot planning, recipes, month plans, location check): bounded inputs shared by validation and mapping. */
export const PLAN_LIMITS = {
  shoots: 12, titleChars: 120, locationChars: 80, equipmentItems: 10, equipmentChars: 60, recipeResults: 5,
  queryChars: 60, hourlyHours: 24, areaResults: 10, timeoutMs: 8000, responseBytes: 262144, forecastDays: 9,
  /** Weather: compressed forecast file and its unpacked size are capped; stations further away are not used. */
  forecastUnpackedBytes: 4194304, maxStationKm: 40,
  /** Month plan and re-scheduling. */
  planPosts: 30, planSpanDays: 62, shiftPosts: 40, existingDates: 60,
} as const;
/** Fixed public read-only hosts for the shoot-location-check package (one GET each, no key, no redirects). */
export const PLAN_SOURCES = {
  /** Official DWD Open Data (MOSMIX_L single-station forecasts). Only a station id is ever put in the path. */
  weather: "https://opendata.dwd.de/weather/local_forecasts/mos/MOSMIX_L/single_stations",
  protectedAreas: "https://www.lfu.bayern.de/gdi/wfs/natur/schutzgebiete",
} as const;
/** Manual OSM pilot import only; no public Overpass backend for buyer calls. */
export const OSM_IMPORT = {
  endpoint: "https://overpass-api.de/api/interpreter",
  region: "chiemsee-pilot", bbox: [47.75, 12.30, 47.95, 12.60] as readonly number[],
  timeoutMs: 30000, queryTimeoutSeconds: 25, queryMemoryBytes: 67108864,
  responseBytes: 5242880, elements: 10000, tagChars: 200,
} as const;
export const REGIONAL_LIMITS = { records: 10000, results: 20, queryChars: 80 } as const;

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
  /** Google Trends Explore Live: per task (up to 5 keywords). */
  trendsLivePerTask: 0.011,
  /** Google Maps SERP Live: per 100 results (depth rounded up). */
  mapsLivePer100: 0.002,
  /** Bing Organic SERP Live: per 10-result page. */
  bingLivePerPage: 0.002,
  /** On-Page Instant Pages: base price per page; JavaScript/resources/browser rendering add-ons are never requested. */
  instantPagesPerPage: 0.00015,
  /** Google News and Images SERP Live: per result page (assumed equal to the other SERP Live endpoints, to be confirmed against a real `cost`). */
  newsLivePerPage: 0.002,
  imagesLivePerPage: 0.002,
  /** Domain Analytics Technologies, domain_technologies Live: per task. */
  domainTechPerTask: 0.012,
} as const;

const labs = (items: number) => DFS_PRICES.labsPerTask + items * DFS_PRICES.labsPerItem;

export const SERVICE_CONFIG: Record<string, ServiceConfig> = {
  "video-recipes": {
    id: "video-recipes", name: "Video Recipes (Shot Lists)", route: "/api/v1/video-recipes",
    worstCaseUsd: 0, priceUsdc: "0.01", referencePriceUsdc: null,
    enabled: true, maxInputs: 1, maxResults: PLAN_LIMITS.recipeResults,
    dataforseoEndpoint: "local:video-recipes", maxUpstreamCostUsd: 0,
    cacheTtlSeconds: 0, upstreamPerMinute: 30, category: "content",
  },
  "shoot-day-plan": {
    id: "shoot-day-plan", name: "Shoot Day Planner", route: "/api/v1/shoot-day-plan",
    worstCaseUsd: 0, priceUsdc: "0.03", referencePriceUsdc: null,
    enabled: true, maxInputs: PLAN_LIMITS.shoots, maxResults: PLAN_LIMITS.shoots,
    dataforseoEndpoint: "local:shoot-day-plan", maxUpstreamCostUsd: 0,
    cacheTtlSeconds: 0, upstreamPerMinute: 30, category: "content",
  },
  "content-month-plan": {
    id: "content-month-plan", name: "Content Month Plan", route: "/api/v1/content-month-plan",
    worstCaseUsd: 0, priceUsdc: "0.05", referencePriceUsdc: null,
    enabled: true, maxInputs: 1, maxResults: PLAN_LIMITS.planPosts,
    dataforseoEndpoint: "local:content-month-plan", maxUpstreamCostUsd: 0,
    cacheTtlSeconds: 0, upstreamPerMinute: 30, category: "content",
  },
  "content-plan-shift": {
    id: "content-plan-shift", name: "Content Plan Re-Schedule", route: "/api/v1/content-plan-shift",
    worstCaseUsd: 0, priceUsdc: "0.02", referencePriceUsdc: null,
    enabled: true, maxInputs: PLAN_LIMITS.shiftPosts, maxResults: PLAN_LIMITS.shiftPosts,
    dataforseoEndpoint: "local:content-plan-shift", maxUpstreamCostUsd: 0,
    cacheTtlSeconds: 0, upstreamPerMinute: 30, category: "content",
  },
  "video-project-plan": {
    id: "video-project-plan", name: "Video Project Plan", route: "/api/v1/video-project-plan",
    worstCaseUsd: 0, priceUsdc: "0.08", referencePriceUsdc: null,
    enabled: true, maxInputs: 1, maxResults: PLAN_LIMITS.shoots,
    dataforseoEndpoint: "local:video-project-plan", maxUpstreamCostUsd: 0,
    cacheTtlSeconds: 0, upstreamPerMinute: 30, category: "content",
  },
  "shoot-location-check": {
    id: "shoot-location-check", name: "Shoot Location Check (package)", route: "/api/v1/shoot-location-check",
    worstCaseUsd: 0, priceUsdc: "0.04", referencePriceUsdc: null,
    enabled: true, maxInputs: 1, maxResults: PLAN_LIMITS.areaResults,
    dataforseoEndpoint: "direct:shoot-location-check", maxUpstreamCostUsd: 0,
    cacheTtlSeconds: 0, upstreamPerMinute: 10, category: "content",
  },
  "open-data-search": {
    id: "open-data-search", name: "Open Data Catalog Search", route: "/api/v1/open-data-search",
    worstCaseUsd: 0, priceUsdc: "0.01", referencePriceUsdc: null,
    enabled: true, maxInputs: 1, maxResults: CATALOG_LIMITS.results,
    dataforseoEndpoint: "catalog:search", maxUpstreamCostUsd: 0,
    cacheTtlSeconds: 900, upstreamPerMinute: 10,
  },
  "website-check": {
    id: "website-check", name: "Website Check (package)", route: "/api/v1/website-check",
    worstCaseUsd: 0, priceUsdc: "0.04", referencePriceUsdc: null,
    enabled: true, maxInputs: WEBSITE_CHECK_LIMITS.links + 1, maxResults: WEBSITE_CHECK_LIMITS.requests,
    dataforseoEndpoint: "direct:website-check", maxUpstreamCostUsd: 0,
    cacheTtlSeconds: 0, upstreamPerMinute: 10,
  },
  "website-content": {
    id: "website-content", name: "Website Content", route: "/api/v1/website-content",
    worstCaseUsd: DFS_PRICES.instantPagesPerPage, priceUsdc: "0.02", referencePriceUsdc: null,
    enabled: true, maxInputs: 1, maxResults: 40,
    dataforseoEndpoint: "/v3/on_page/content_parsing/live", maxUpstreamCostUsd: 0.005,
    cacheTtlSeconds: 300, upstreamPerMinute: 30,
  },
  "website-changes": {
    id: "website-changes", name: "Website Changes", route: "/api/v1/website-changes",
    worstCaseUsd: DFS_PRICES.instantPagesPerPage, priceUsdc: "0.025", referencePriceUsdc: null,
    enabled: true, maxInputs: 1, maxResults: 40,
    dataforseoEndpoint: "/v3/on_page/content_parsing/live", maxUpstreamCostUsd: 0.005,
    cacheTtlSeconds: 0, upstreamPerMinute: 30,
  },
  "regional-data": {
    id: "regional-data", name: "Regional Places (Chiemgau)", route: "/api/v1/regional-data",
    worstCaseUsd: 0, priceUsdc: "0.01", referencePriceUsdc: null,
    enabled: true, maxInputs: 1, maxResults: 20,
    dataforseoEndpoint: "local:regional-data", maxUpstreamCostUsd: 0,
    cacheTtlSeconds: 0, upstreamPerMinute: 30,
  },
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
  "keyword-gap": {
    id: "keyword-gap",
    name: "Keyword Gap",
    route: "/api/v1/keyword-gap",
    worstCaseUsd: labs(25),
    priceUsdc: "0.045",
    referencePriceUsdc: "0.05",
    enabled: true,
    maxInputs: 2,
    maxResults: 25,
    dataforseoEndpoint: "/v3/dataforseo_labs/google/domain_intersection/live",
    maxUpstreamCostUsd: 0.03,
    cacheTtlSeconds: 24 * 3600,
    upstreamPerMinute: 60,
  },
  "google-trends": {
    id: "google-trends",
    name: "Google Trends",
    route: "/api/v1/google-trends",
    worstCaseUsd: DFS_PRICES.trendsLivePerTask,
    priceUsdc: "0.025",
    referencePriceUsdc: null,
    enabled: true,
    maxInputs: 5,
    maxResults: 5,
    dataforseoEndpoint: "/v3/keywords_data/google_trends/explore/live",
    maxUpstreamCostUsd: 0.02,
    cacheTtlSeconds: 24 * 3600,
    upstreamPerMinute: 60,
  },
  "local-business": {
    id: "local-business",
    name: "Local Business Search",
    route: "/api/v1/local-business",
    worstCaseUsd: DFS_PRICES.mapsLivePer100,
    priceUsdc: "0.03",
    referencePriceUsdc: null,
    enabled: true,
    maxInputs: 1,
    maxResults: 20,
    dataforseoEndpoint: "/v3/serp/google/maps/live/advanced",
    maxUpstreamCostUsd: 0.01,
    cacheTtlSeconds: 6 * 3600,
    upstreamPerMinute: 60,
  },
  "bing-serp": {
    id: "bing-serp",
    name: "Bing SERP",
    route: "/api/v1/bing-serp",
    worstCaseUsd: DFS_PRICES.bingLivePerPage,
    priceUsdc: "0.02",
    referencePriceUsdc: null,
    enabled: true,
    maxInputs: 1,
    maxResults: 10,
    dataforseoEndpoint: "/v3/serp/bing/organic/live/advanced",
    maxUpstreamCostUsd: 0.01,
    cacheTtlSeconds: 6 * 3600,
    upstreamPerMinute: 60,
  },
  "page-audit": {
    id: "page-audit",
    name: "Page Audit",
    route: "/api/v1/page-audit",
    worstCaseUsd: DFS_PRICES.instantPagesPerPage,
    priceUsdc: "0.02",
    referencePriceUsdc: "0.03",
    enabled: true,
    maxInputs: 1,
    maxResults: 1,
    dataforseoEndpoint: "/v3/on_page/instant_pages",
    maxUpstreamCostUsd: 0.005,
    cacheTtlSeconds: 3600,
    upstreamPerMinute: 30,
  },
  "domain-technologies": {
    id: "domain-technologies",
    name: "Domain Technologies",
    route: "/api/v1/domain-technologies",
    worstCaseUsd: DFS_PRICES.domainTechPerTask,
    priceUsdc: "0.03",
    referencePriceUsdc: null,
    enabled: true,
    maxInputs: 1,
    maxResults: 1,
    dataforseoEndpoint: "/v3/domain_analytics/technologies/domain_technologies/live",
    maxUpstreamCostUsd: 0.02,
    cacheTtlSeconds: 7 * 24 * 3600,
    upstreamPerMinute: 60,
  },
  "keywords-for-site": {
    id: "keywords-for-site",
    name: "Keywords for Site",
    route: "/api/v1/keywords-for-site",
    worstCaseUsd: labs(25),
    priceUsdc: "0.04",
    referencePriceUsdc: "0.05",
    enabled: true,
    maxInputs: 1,
    maxResults: 25,
    dataforseoEndpoint: "/v3/dataforseo_labs/google/keywords_for_site/live",
    maxUpstreamCostUsd: 0.03,
    cacheTtlSeconds: 24 * 3600,
    upstreamPerMinute: 60,
  },
  "traffic-estimate": {
    id: "traffic-estimate",
    name: "Traffic Estimate",
    route: "/api/v1/traffic-estimate",
    worstCaseUsd: labs(10),
    priceUsdc: "0.04",
    referencePriceUsdc: "0.05",
    enabled: true,
    maxInputs: 10,
    maxResults: 10,
    dataforseoEndpoint: "/v3/dataforseo_labs/google/bulk_traffic_estimation/live",
    maxUpstreamCostUsd: 0.03,
    cacheTtlSeconds: 24 * 3600,
    upstreamPerMinute: 60,
  },
  "news-search": {
    id: "news-search",
    name: "Google News Search",
    route: "/api/v1/news-search",
    worstCaseUsd: DFS_PRICES.newsLivePerPage,
    priceUsdc: "0.02",
    referencePriceUsdc: "0.03",
    enabled: true,
    maxInputs: 1,
    maxResults: 10,
    dataforseoEndpoint: "/v3/serp/google/news/live/advanced",
    maxUpstreamCostUsd: 0.01,
    cacheTtlSeconds: 3600,
    upstreamPerMinute: 60,
  },
  "image-search": {
    id: "image-search",
    name: "Google Image Search",
    route: "/api/v1/image-search",
    worstCaseUsd: DFS_PRICES.imagesLivePerPage,
    priceUsdc: "0.02",
    referencePriceUsdc: "0.03",
    enabled: true,
    maxInputs: 1,
    maxResults: 20,
    dataforseoEndpoint: "/v3/serp/google/images/live/advanced",
    maxUpstreamCostUsd: 0.01,
    cacheTtlSeconds: 6 * 3600,
    upstreamPerMinute: 60,
  },
  "local-market-check": {
    id: "local-market-check",
    name: "Local Market Check (package)",
    route: "/api/v1/local-market-check",
    // Package: one Google organic SERP page + one Google Maps page (two upstream calls per payment, fixed).
    worstCaseUsd: DFS_PRICES.serpLivePerPage + DFS_PRICES.mapsLivePer100,
    priceUsdc: "0.09",
    referencePriceUsdc: "0.10",
    enabled: true,
    maxInputs: 1,
    maxResults: 10,
    dataforseoEndpoint: "/v3/serp/google/organic/live/advanced",
    maxUpstreamCostUsd: 0.02,
    cacheTtlSeconds: 6 * 3600,
    upstreamPerMinute: 30,
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
