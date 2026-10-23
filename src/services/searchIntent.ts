import { z } from "zod";
import { DFS_PRICES, serviceConfig } from "../config/services.js";
import type { ServiceDefinition } from "./types.js";
import { arr, keywordList, missingKeywords, num, obj, str } from "./common.js";

const cfg = serviceConfig("search-intent");

// No location/language: the DataForSEO endpoint takes keywords only.
const input = z.strictObject({ keywords: keywordList(cfg.maxInputs) });
type Input = z.output<typeof input>;

export interface IntentLabel {
  label: string | null;
  /** Classifier confidence, 0-1. */
  probability: number | null;
}

export interface SearchIntentResult {
  keyword: string;
  /** Most likely intent: informational | navigational | commercial | transactional. */
  intent: string | null;
  probability: number | null;
  /** Other plausible intents, if the classifier found any. */
  secondary_intents: IntentLabel[];
}

export interface SearchIntentOutput {
  keywords: SearchIntentResult[];
  /** Requested keywords the classifier returned nothing for. */
  not_classified: string[];
}

const label = (raw: unknown): IntentLabel => {
  const o = obj(raw);
  return { label: str(o.label), probability: num(o.probability) };
};

export const searchIntent: ServiceDefinition<Input, SearchIntentOutput> = {
  id: cfg.id,
  name: cfg.name,
  summary: `Search intent (informational, navigational, commercial, transactional) with probability for up to ${cfg.maxInputs} keywords (DataForSEO Labs Search Intent). Use it to decide whether a keyword suits an informational, commercial or transactional page.`,
  route: cfg.route,
  priceUsdc: cfg.priceUsdc,
  enabled: cfg.enabled,
  cacheTtlSeconds: cfg.cacheTtlSeconds,
  limits: { maxInputs: cfg.maxInputs, maxResults: cfg.maxResults },
  upstream: { endpoint: cfg.dataforseoEndpoint, maxCostUsd: cfg.maxUpstreamCostUsd },
  inputSchema: input,
  notice: "Intent labels come from DataForSEO's classifier. Language coverage is determined by DataForSEO; results for non-English keywords are not guaranteed.",
  example: { keywords: ["buy running shoes", "how to tie a tie"] },
  outputExample: {
    keywords: [
      { keyword: "buy running shoes", intent: "transactional", probability: 0.98, secondary_intents: [{ label: "commercial", probability: 0.31 }] },
    ],
    not_classified: [],
  },

  estimateCostUsd: (i) => DFS_PRICES.labsPerTask + i.keywords.length * DFS_PRICES.labsPerItem,

  buildRequest: (i) => [{ keywords: i.keywords }],

  mapResult(task, i) {
    const r = obj(arr(task.result)[0]);
    const keywords = arr(r.items)
      .slice(0, cfg.maxResults)
      .map((raw): SearchIntentResult => {
        const item = obj(raw);
        const primary = label(item.keyword_intent);
        return {
          keyword: str(item.keyword) ?? "",
          intent: primary.label,
          probability: primary.probability,
          secondary_intents: arr(item.secondary_keyword_intents).map(label),
        };
      });
    return { keywords, not_classified: missingKeywords(i.keywords, keywords.map((k) => k.keyword)) };
  },
};
