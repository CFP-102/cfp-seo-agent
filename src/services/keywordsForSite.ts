import { z } from "zod";
import { DFS_PRICES, serviceConfig } from "../config/services.js";
import type { ServiceDefinition } from "./types.js";
import { arr, domainString, localeValidator, num, obj, round2, str, withLocale } from "./common.js";

const cfg = serviceConfig("keywords-for-site");

const input = withLocale({ domain: domainString });
type Input = z.output<typeof input>;

export interface SiteKeyword {
  keyword: string;
  search_volume: number | null;
  cpc: number | null;
  competition_level: string | null;
  keyword_difficulty: number | null;
  main_intent: string | null;
}

export interface KeywordsForSiteOutput {
  domain: string;
  location_code: number;
  language_code: string;
  /** Number of relevant keywords DataForSEO knows for this site; we return at most `limits.maxResults`. */
  total_available: number | null;
  keywords: SiteKeyword[];
}

export const keywordsForSite: ServiceDefinition<Input, KeywordsForSiteOutput> = {
  id: cfg.id,
  name: cfg.name,
  summary: `Up to ${cfg.maxResults} Google keywords relevant to a website, with search volume, CPC, competition, difficulty and intent (DataForSEO Labs Keywords For Site).`,
  route: cfg.route,
  priceUsdc: cfg.priceUsdc,
  enabled: cfg.enabled,
  cacheTtlSeconds: cfg.cacheTtlSeconds,
  limits: { maxInputs: cfg.maxInputs, maxResults: cfg.maxResults },
  upstream: { endpoint: cfg.dataforseoEndpoint, maxCostUsd: cfg.maxUpstreamCostUsd },
  inputSchema: input,
  validateInput: localeValidator("labs"),
  example: { domain: "example.com", location_code: 2840, language_code: "en" },
  outputExample: {
    domain: "example.com",
    location_code: 2840,
    language_code: "en",
    total_available: 103477,
    keywords: [{ keyword: "example domain", search_volume: 5400, cpc: 0.8, competition_level: "LOW", keyword_difficulty: 12, main_intent: "informational" }],
  },

  estimateCostUsd: () => DFS_PRICES.labsPerTask + cfg.maxResults * DFS_PRICES.labsPerItem,

  buildRequest: (i) => [
    { target: i.domain, location_code: i.location_code, language_code: i.language_code, limit: cfg.maxResults, include_serp_info: false, include_clickstream_data: false },
  ],

  mapResult(task, i) {
    const r = obj(arr(task.result)[0]);
    const keywords = arr(r.items)
      .slice(0, cfg.maxResults)
      .map((raw): SiteKeyword => {
        const item = obj(raw);
        const info = obj(item.keyword_info);
        return {
          keyword: str(item.keyword) ?? "",
          search_volume: num(info.search_volume),
          cpc: round2(num(info.cpc)),
          competition_level: str(info.competition_level),
          keyword_difficulty: num(obj(item.keyword_properties).keyword_difficulty),
          main_intent: str(obj(item.search_intent_info).main_intent),
        };
      });
    return { domain: i.domain, location_code: i.location_code, language_code: i.language_code, total_available: num(r.total_count), keywords };
  },
};
