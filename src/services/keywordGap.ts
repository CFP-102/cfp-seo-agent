import { z } from "zod";
import { DFS_PRICES, serviceConfig } from "../config/services.js";
import type { ServiceDefinition } from "./types.js";
import { arr, domainString, localeValidator, num, obj, round2, str, withLocale } from "./common.js";

const cfg = serviceConfig("keyword-gap");

const input = withLocale({ domain: domainString, competitor: domainString }).refine((v) => v.domain !== v.competitor, {
  message: "domain and competitor must be different domains",
  path: ["competitor"],
});
type Input = z.output<typeof input>;

export interface GapKeyword {
  keyword: string;
  /** Position of the competitor in Google's organic results. */
  competitor_position: number | null;
  competitor_url: string | null;
  search_volume: number | null;
  cpc: number | null;
  competition_level: string | null;
  keyword_difficulty: number | null;
}

export interface KeywordGapOutput {
  domain: string;
  competitor: string;
  location_code: number;
  language_code: string;
  /** Number of keywords the competitor ranks for and the domain does not; we return at most `limits.maxResults`, highest search volume first. */
  total_available: number | null;
  keywords: GapKeyword[];
}

export const keywordGap: ServiceDefinition<Input, KeywordGapOutput> = {
  id: cfg.id,
  name: cfg.name,
  summary: `Keywords a competitor ranks for in Google but your domain does not: up to ${cfg.maxResults}, highest search volume first, with the competitor's ranking page (DataForSEO Labs Domain Intersection).`,
  route: cfg.route,
  priceUsdc: cfg.priceUsdc,
  enabled: cfg.enabled,
  cacheTtlSeconds: cfg.cacheTtlSeconds,
  limits: { maxInputs: cfg.maxInputs, maxResults: cfg.maxResults },
  upstream: { endpoint: cfg.dataforseoEndpoint, maxCostUsd: cfg.maxUpstreamCostUsd },
  inputSchema: input,
  validateInput: localeValidator("labs"),
  example: { domain: "example.com", competitor: "competitor.com", location_code: 2840, language_code: "en" },
  outputExample: {
    domain: "example.com",
    competitor: "competitor.com",
    location_code: 2840,
    language_code: "en",
    total_available: 1204,
    keywords: [
      {
        keyword: "best running shoes",
        competitor_position: 4,
        competitor_url: "https://www.competitor.com/best-running-shoes",
        search_volume: 49500,
        cpc: 1.2,
        competition_level: "HIGH",
        keyword_difficulty: 68,
      },
    ],
  },

  estimateCostUsd: () => DFS_PRICES.labsPerTask + cfg.maxResults * DFS_PRICES.labsPerItem,

  // intersections=false: keywords where target1 (the competitor) ranks and target2 (our caller) does not.
  buildRequest: (i) => [
    {
      target1: i.competitor,
      target2: i.domain,
      location_code: i.location_code,
      language_code: i.language_code,
      intersections: false,
      item_types: ["organic"],
      limit: cfg.maxResults,
      order_by: ["keyword_data.keyword_info.search_volume,desc"],
      include_serp_info: false,
      include_clickstream_data: false,
    },
  ],

  mapResult(task, i) {
    const r = obj(arr(task.result)[0]);
    const keywords = arr(r.items)
      .slice(0, cfg.maxResults)
      .map((raw): GapKeyword => {
        const item = obj(raw);
        const kd = obj(item.keyword_data);
        const info = obj(kd.keyword_info);
        const serp = obj(item.first_domain_serp_element);
        return {
          keyword: str(kd.keyword) ?? "",
          competitor_position: num(serp.rank_group),
          competitor_url: str(serp.url),
          search_volume: num(info.search_volume),
          cpc: round2(num(info.cpc)),
          competition_level: str(info.competition_level),
          keyword_difficulty: num(obj(kd.keyword_properties).keyword_difficulty),
        };
      });
    return { domain: i.domain, competitor: i.competitor, location_code: i.location_code, language_code: i.language_code, total_available: num(r.total_count), keywords };
  },
};
