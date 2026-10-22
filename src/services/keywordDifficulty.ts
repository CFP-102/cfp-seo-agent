import { z } from "zod";
import { DFS_PRICES, serviceConfig } from "../config/services.js";
import type { ServiceDefinition } from "./types.js";
import { arr, keywordList, localeValidator, missingKeywords, num, obj, str, withLocale } from "./common.js";

const cfg = serviceConfig("keyword-difficulty");

const input = withLocale({ keywords: keywordList(cfg.maxInputs) });
type Input = z.output<typeof input>;

export interface KeywordDifficultyOutput {
  location_code: number;
  language_code: string;
  /** Difficulty 0-100: how hard it is to rank in Google's top 10 organic results for the keyword (higher = harder). */
  keywords: { keyword: string; keyword_difficulty: number | null }[];
  /** Requested keywords DataForSEO returned nothing for. */
  not_found: string[];
}

export const keywordDifficulty: ServiceDefinition<Input, KeywordDifficultyOutput> = {
  id: cfg.id,
  name: cfg.name,
  summary: `Keyword difficulty score (0-100) for up to ${cfg.maxInputs} keywords (DataForSEO Labs Bulk Keyword Difficulty).`,
  route: cfg.route,
  priceUsdc: cfg.priceUsdc,
  enabled: cfg.enabled,
  cacheTtlSeconds: cfg.cacheTtlSeconds,
  limits: { maxInputs: cfg.maxInputs, maxResults: cfg.maxResults },
  upstream: { endpoint: cfg.dataforseoEndpoint, maxCostUsd: cfg.maxUpstreamCostUsd },
  inputSchema: input,
  validateInput: localeValidator("labs"),
  example: { keywords: ["running shoes", "trail running shoes"], location_code: 2840, language_code: "en" },
  outputExample: {
    location_code: 2840,
    language_code: "en",
    keywords: [{ keyword: "running shoes", keyword_difficulty: 71 }],
    not_found: [],
  },

  // Billed per returned keyword.
  estimateCostUsd: (i) => DFS_PRICES.labsPerTask + i.keywords.length * DFS_PRICES.labsPerItem,

  buildRequest: (i) => [{ keywords: i.keywords, location_code: i.location_code, language_code: i.language_code }],

  mapResult(task, i) {
    const r = obj(arr(task.result)[0]);
    const keywords = arr(r.items)
      .slice(0, cfg.maxResults)
      .map((raw) => {
        const item = obj(raw);
        return { keyword: str(item.keyword) ?? "", keyword_difficulty: num(item.keyword_difficulty) };
      });
    return { location_code: i.location_code, language_code: i.language_code, keywords, not_found: missingKeywords(i.keywords, keywords.map((k) => k.keyword)) };
  },
};
