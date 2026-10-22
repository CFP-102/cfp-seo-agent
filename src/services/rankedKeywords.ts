import { z } from "zod";
import { DFS_PRICES, serviceConfig } from "../config/services.js";
import type { ServiceDefinition } from "./types.js";
import { arr, domainString, localeValidator, num, obj, round2, str, withLocale } from "./common.js";

const cfg = serviceConfig("ranked-keywords");

const input = withLocale({ domain: domainString });
type Input = z.output<typeof input>;

export interface RankedKeyword {
  keyword: string;
  /** Rank among organic results (1 = first organic result). */
  position: number | null;
  /** Rank among all elements on the result page. */
  absolute_position: number | null;
  /** The page of the domain that ranks. */
  url: string | null;
  search_volume: number | null;
  cpc: number | null;
  competition_level: string | null;
  keyword_difficulty: number | null;
  /** Estimated monthly visits this ranking brings (DataForSEO "etv"). */
  estimated_traffic: number | null;
}

export interface RankedKeywordsOutput {
  target: string;
  location_code: number;
  language_code: string;
  /** Number of ranking keywords DataForSEO knows for this domain; we return at most `limits.maxResults`. */
  total_available: number | null;
  keywords: RankedKeyword[];
}

export const rankedKeywords: ServiceDefinition<Input, RankedKeywordsOutput> = {
  id: cfg.id,
  name: cfg.name,
  summary: `Up to ${cfg.maxResults} Google keywords a domain ranks for, with position, ranking page, search volume, CPC and difficulty (DataForSEO Labs Ranked Keywords).`,
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
    target: "example.com",
    location_code: 2840,
    language_code: "en",
    total_available: 8806,
    keywords: [
      {
        keyword: "example domain",
        position: 1,
        absolute_position: 2,
        url: "https://www.example.com/",
        search_volume: 5400,
        cpc: 0.8,
        competition_level: "LOW",
        keyword_difficulty: 12,
        estimated_traffic: 1800.5,
      },
    ],
  },

  estimateCostUsd: () => DFS_PRICES.labsPerTask + cfg.maxResults * DFS_PRICES.labsPerItem,

  buildRequest: (i) => [{ target: i.domain, location_code: i.location_code, language_code: i.language_code, limit: cfg.maxResults, include_clickstream_data: false }],

  mapResult(task, i) {
    const r = obj(arr(task.result)[0]);
    const keywords = arr(r.items)
      .slice(0, cfg.maxResults)
      .map((raw): RankedKeyword => {
        const item = obj(raw);
        const kd = obj(item.keyword_data);
        const info = obj(kd.keyword_info);
        const serp = obj(obj(item.ranked_serp_element).serp_item);
        return {
          keyword: str(kd.keyword) ?? "",
          position: num(serp.rank_group),
          absolute_position: num(serp.rank_absolute),
          url: str(serp.url),
          search_volume: num(info.search_volume),
          cpc: num(info.cpc),
          competition_level: str(info.competition_level),
          keyword_difficulty: num(obj(kd.keyword_properties).keyword_difficulty),
          estimated_traffic: round2(num(serp.etv)),
        };
      });
    return { target: i.domain, location_code: i.location_code, language_code: i.language_code, total_available: num(r.total_count), keywords };
  },
};
