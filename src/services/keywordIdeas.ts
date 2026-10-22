import { z } from "zod";
import { DFS_PRICES, serviceConfig } from "../config/services.js";
import type { ServiceDefinition } from "./types.js";
import { arr, keywordList, localeValidator, num, obj, str, withLocale } from "./common.js";

const cfg = serviceConfig("keyword-ideas");

const input = withLocale({ keywords: keywordList(cfg.maxInputs) });
type Input = z.output<typeof input>;

export interface KeywordIdea {
  keyword: string;
  search_volume: number | null;
  /** Average cost per click in USD. */
  cpc: number | null;
  /** Competition 0-1 (paid search). */
  competition: number | null;
  competition_level: string | null;
  low_top_of_page_bid: number | null;
  high_top_of_page_bid: number | null;
  keyword_difficulty: number | null;
  main_intent: string | null;
}

export interface KeywordIdeasOutput {
  location_code: number;
  language_code: string;
  seed_keywords: string[];
  /** Total ideas DataForSEO has for these seeds; we return at most `limits.maxResults` of them. */
  total_available: number | null;
  ideas: KeywordIdea[];
}

export const keywordIdeas: ServiceDefinition<Input, KeywordIdeasOutput> = {
  id: cfg.id,
  name: cfg.name,
  summary: `Up to ${cfg.maxResults} keyword suggestions containing the words of one seed phrase, with search volume, CPC and competition (DataForSEO Labs Keyword Suggestions).`,
  route: cfg.route,
  priceUsdc: cfg.priceUsdc,
  enabled: cfg.enabled,
  cacheTtlSeconds: cfg.cacheTtlSeconds,
  limits: { maxInputs: cfg.maxInputs, maxResults: cfg.maxResults },
  upstream: { endpoint: cfg.dataforseoEndpoint, maxCostUsd: cfg.maxUpstreamCostUsd },
  inputSchema: input,
  validateInput: localeValidator("labs"),
  example: { keywords: ["running shoes"], location_code: 2840, language_code: "en" },
  outputExample: {
    location_code: 2840,
    language_code: "en",
    seed_keywords: ["running shoes"],
    total_available: 52000,
    ideas: [
      {
        keyword: "trail running shoes",
        search_volume: 74000,
        cpc: 1.1,
        competition: 0.87,
        competition_level: "HIGH",
        low_top_of_page_bid: 0.45,
        high_top_of_page_bid: 2.2,
        keyword_difficulty: 62,
        main_intent: "commercial",
      },
    ],
  },

  // Billed per returned item; `limit` caps it. Clickstream data (x2 price) is never requested.
  estimateCostUsd: () => DFS_PRICES.labsPerTask + cfg.maxResults * DFS_PRICES.labsPerItem,

  buildRequest: (i) => [
    {
      keyword: i.keywords[0],
      location_code: i.location_code,
      language_code: i.language_code,
      limit: cfg.maxResults,
      include_serp_info: false,
      include_clickstream_data: false,
    },
  ],

  mapResult(task, i) {
    const r = obj(arr(task.result)[0]);
    const ideas = arr(r.items)
      .slice(0, cfg.maxResults)
      .map((raw): KeywordIdea => {
        const item = obj(raw);
        const info = obj(item.keyword_info);
        return {
          keyword: str(item.keyword) ?? "",
          search_volume: num(info.search_volume),
          cpc: num(info.cpc),
          competition: num(info.competition),
          competition_level: str(info.competition_level),
          low_top_of_page_bid: num(info.low_top_of_page_bid),
          high_top_of_page_bid: num(info.high_top_of_page_bid),
          keyword_difficulty: num(obj(item.keyword_properties).keyword_difficulty),
          main_intent: str(obj(item.search_intent_info).main_intent),
        };
      });
    return {
      location_code: i.location_code,
      language_code: i.language_code,
      seed_keywords: i.keywords,
      total_available: num(r.total_count),
      ideas,
    };
  },
};
