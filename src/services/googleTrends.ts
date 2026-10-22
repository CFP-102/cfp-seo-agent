import { z } from "zod";
import { DFS_PRICES, serviceConfig } from "../config/services.js";
import type { ServiceDefinition } from "./types.js";
import { arr, keywordList, localeValidator, num, obj, str, withLocale } from "./common.js";

const cfg = serviceConfig("google-trends");

const input = withLocale({ keywords: keywordList(cfg.maxInputs) });
type Input = z.output<typeof input>;

export interface TrendsPoint {
  date_from: string | null;
  date_to: string | null;
  /** Relative interest 0-100 per requested keyword, in the order of `keywords` (null = no data). */
  values: (number | null)[];
}

export interface GoogleTrendsOutput {
  location_code: number;
  language_code: string;
  keywords: string[];
  /** Interest over time for the past 12 months. 100 = peak popularity among the compared keywords. */
  points: TrendsPoint[];
}

export const googleTrends: ServiceDefinition<Input, GoogleTrendsOutput> = {
  id: cfg.id,
  name: cfg.name,
  summary: `Google Trends interest over time (past 12 months, relative 0-100) for up to ${cfg.maxInputs} keywords compared against each other (DataForSEO Google Trends Explore Live).`,
  route: cfg.route,
  priceUsdc: cfg.priceUsdc,
  enabled: cfg.enabled,
  cacheTtlSeconds: cfg.cacheTtlSeconds,
  limits: { maxInputs: cfg.maxInputs, maxResults: cfg.maxResults },
  upstream: { endpoint: cfg.dataforseoEndpoint, maxCostUsd: cfg.maxUpstreamCostUsd },
  inputSchema: input,
  validateInput: localeValidator("trends"),
  example: { keywords: ["running shoes", "trail shoes"], location_code: 2840, language_code: "en" },
  outputExample: {
    location_code: 2840,
    language_code: "en",
    keywords: ["running shoes", "trail shoes"],
    points: [{ date_from: "2025-10-12", date_to: "2025-10-18", values: [45, 12] }],
  },

  // Flat per task, independent of the keyword count (max 5 per task).
  estimateCostUsd: () => DFS_PRICES.trendsLivePerTask,

  buildRequest: (i) => [
    { keywords: i.keywords, location_code: i.location_code, language_code: i.language_code, type: "web", time_range: "past_12_months", item_types: ["google_trends_graph"] },
  ],

  mapResult(task, i) {
    const r = obj(arr(task.result)[0]);
    const graph = arr(r.items).map(obj).find((item) => item.type === "google_trends_graph");
    const points = arr(graph?.data).map(
      (raw): TrendsPoint => {
        const p = obj(raw);
        return { date_from: str(p.date_from), date_to: str(p.date_to), values: arr(p.values).map(num) };
      },
    );
    return { location_code: i.location_code, language_code: i.language_code, keywords: i.keywords, points };
  },
};
