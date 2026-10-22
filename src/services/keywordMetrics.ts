import { z } from "zod";
import { DFS_PRICES, serviceConfig } from "../config/services.js";
import type { ServiceDefinition } from "./types.js";
import { keywordList, localeValidator, num, str, withLocale } from "./common.js";

const cfg = serviceConfig("keyword-metrics");

const input = withLocale({ keywords: keywordList(cfg.maxInputs) });
type Input = z.output<typeof input>;

export interface KeywordMetric {
  keyword: string;
  search_volume: number | null;
  /** Google Ads competition bucket for paid search: LOW | MEDIUM | HIGH. */
  competition: string | null;
  /** Google Ads competition index 0-100. */
  competition_index: number | null;
  /** Average cost per click in USD. */
  cpc: number | null;
  low_top_of_page_bid: number | null;
  high_top_of_page_bid: number | null;
  monthly_searches: { year: number; month: number; search_volume: number | null }[] | null;
}

export interface KeywordMetricsOutput {
  location_code: number;
  language_code: string;
  keywords: KeywordMetric[];
}

export const keywordMetrics: ServiceDefinition<Input, KeywordMetricsOutput> = {
  id: cfg.id,
  name: cfg.name,
  summary:
    "Google Ads search volume, competition, CPC and 12-month history for up to 1000 keywords per call (DataForSEO Google Ads Search Volume Live).",
  route: cfg.route,
  priceUsdc: cfg.priceUsdc,
  enabled: cfg.enabled,
  cacheTtlSeconds: cfg.cacheTtlSeconds,
  limits: { maxInputs: cfg.maxInputs, maxResults: cfg.maxResults },
  upstream: { endpoint: cfg.dataforseoEndpoint, maxCostUsd: cfg.maxUpstreamCostUsd },
  inputSchema: input,
  validateInput: localeValidator("google_ads"),
  example: { keywords: ["running shoes", "trail running shoes"], location_code: 2840, language_code: "en" },
  outputExample: {
    location_code: 2840,
    language_code: "en",
    keywords: [
      {
        keyword: "running shoes",
        search_volume: 301000,
        competition: "HIGH",
        competition_index: 100,
        cpc: 1.25,
        low_top_of_page_bid: 0.5,
        high_top_of_page_bid: 2.5,
        monthly_searches: [{ year: 2026, month: 9, search_volume: 320000 }],
      },
    ],
  },

  // Priced per task, not per keyword.
  estimateCostUsd: () => DFS_PRICES.googleAdsLivePerTask,

  buildRequest: (i) => [{ keywords: i.keywords, location_code: i.location_code, language_code: i.language_code }],

  mapResult(task, i) {
    const rows = Array.isArray(task.result) ? task.result : [];
    const keywords = rows.slice(0, cfg.maxResults).map((raw): KeywordMetric => {
      const r = (raw ?? {}) as Record<string, unknown>;
      const monthly = Array.isArray(r.monthly_searches)
        ? (r.monthly_searches as Record<string, unknown>[]).map((m) => ({
            year: num(m.year) ?? 0,
            month: num(m.month) ?? 0,
            search_volume: num(m.search_volume),
          }))
        : null;
      return {
        keyword: str(r.keyword) ?? "",
        search_volume: num(r.search_volume),
        competition: str(r.competition),
        competition_index: num(r.competition_index),
        cpc: num(r.cpc),
        low_top_of_page_bid: num(r.low_top_of_page_bid),
        high_top_of_page_bid: num(r.high_top_of_page_bid),
        monthly_searches: monthly,
      };
    });
    return { location_code: i.location_code, language_code: i.language_code, keywords };
  },
};
