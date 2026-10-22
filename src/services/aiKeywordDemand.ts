import { z } from "zod";
import { DFS_PRICES, serviceConfig } from "../config/services.js";
import type { ServiceDefinition } from "./types.js";
import { arr, keywordList, localeValidator, missingKeywords, num, obj, str, withLocale } from "./common.js";

const cfg = serviceConfig("ai-keyword-demand");

const input = withLocale({ keywords: keywordList(cfg.maxInputs) });
type Input = z.output<typeof input>;

export const AI_DEMAND_METHODOLOGY =
  "Modeled estimate, not a measured count. DataForSEO calculates AI search volume from statistical data on questions in Google's 'People Also Ask' " +
  "results; it does not report actual prompt counts from any AI platform (ChatGPT, Gemini, Perplexity, ...). Use it as a relative demand indicator.";

export interface AiKeywordDemand {
  keyword: string;
  /** Estimated AI search volume for the most recent month. */
  ai_search_volume: number | null;
  /** Estimated monthly AI search volume for the previous 12 months. */
  monthly_estimates: { year: number; month: number; ai_search_volume: number | null }[];
}

export interface AiKeywordDemandOutput {
  /** Always true: every number here is a modeled estimate. */
  estimate: true;
  source: "DataForSEO AI Optimization - AI Keyword Search Volume";
  methodology: string;
  location_code: number;
  language_code: string;
  keywords: AiKeywordDemand[];
  not_found: string[];
}

export const aiKeywordDemand: ServiceDefinition<Input, AiKeywordDemandOutput> = {
  id: cfg.id,
  name: cfg.name,
  summary: `Modeled (estimated) AI-search demand for up to ${cfg.maxInputs} keywords with 12-month history (DataForSEO AI Optimization Keyword Search Volume).`,
  route: cfg.route,
  priceUsdc: cfg.priceUsdc,
  enabled: cfg.enabled,
  cacheTtlSeconds: cfg.cacheTtlSeconds,
  limits: { maxInputs: cfg.maxInputs, maxResults: cfg.maxResults },
  upstream: { endpoint: cfg.dataforseoEndpoint, maxCostUsd: cfg.maxUpstreamCostUsd },
  inputSchema: input,
  validateInput: localeValidator("ai"),
  notice: AI_DEMAND_METHODOLOGY,
  example: { keywords: ["seo tools", "keyword research"], location_code: 2840, language_code: "en" },
  outputExample: {
    estimate: true,
    source: "DataForSEO AI Optimization - AI Keyword Search Volume",
    methodology: AI_DEMAND_METHODOLOGY,
    location_code: 2840,
    language_code: "en",
    keywords: [{ keyword: "seo tools", ai_search_volume: 117209, monthly_estimates: [{ year: 2026, month: 9, ai_search_volume: 117209 }] }],
    not_found: [],
  },

  estimateCostUsd: (i) => DFS_PRICES.aiKeywordPerTask + i.keywords.length * DFS_PRICES.aiKeywordPerItem,

  buildRequest: (i) => [{ keywords: i.keywords, location_code: i.location_code, language_code: i.language_code }],

  mapResult(task, i) {
    const r = obj(arr(task.result)[0]);
    const keywords = arr(r.items)
      .slice(0, cfg.maxResults)
      .map((raw): AiKeywordDemand => {
        const item = obj(raw);
        return {
          keyword: str(item.keyword) ?? "",
          ai_search_volume: num(item.ai_search_volume),
          monthly_estimates: arr(item.ai_monthly_searches).map((m) => {
            const o = obj(m);
            return { year: num(o.year) ?? 0, month: num(o.month) ?? 0, ai_search_volume: num(o.ai_search_volume) };
          }),
        };
      });
    return {
      estimate: true,
      source: "DataForSEO AI Optimization - AI Keyword Search Volume",
      methodology: AI_DEMAND_METHODOLOGY,
      location_code: i.location_code,
      language_code: i.language_code,
      keywords,
      not_found: missingKeywords(i.keywords, keywords.map((k) => k.keyword)),
    };
  },
};
