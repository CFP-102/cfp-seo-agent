import { z } from "zod";
import { DFS_PRICES, serviceConfig } from "../config/services.js";
import type { ServiceDefinition } from "./types.js";
import { arr, domainString, localeValidator, num, obj, round2, str, withLocale } from "./common.js";

const cfg = serviceConfig("competitors");

const input = withLocale({ domain: domainString });
type Input = z.output<typeof input>;

export interface Competitor {
  domain: string | null;
  /** Number of keywords both domains rank for (ranking overlap). */
  intersections: number | null;
  /** Average position of this competitor across the shared keywords. */
  avg_position: number | null;
  /** Metrics for the competitor's whole domain. */
  domain_metrics: {
    organic_keywords: number | null;
    /** Estimated monthly organic visits (DataForSEO "etv"). */
    organic_traffic_estimate: number | null;
    /** What that traffic would cost to buy via ads, USD per month. */
    organic_traffic_value_usd: number | null;
    paid_keywords: number | null;
  };
  /** Metrics restricted to the keywords shared with the target. */
  shared_keyword_metrics: {
    organic_keywords: number | null;
    organic_traffic_estimate: number | null;
    organic_traffic_value_usd: number | null;
    top3_keywords: number | null;
    top10_keywords: number | null;
  };
}

export interface CompetitorsOutput {
  target: string;
  location_code: number;
  language_code: string;
  total_available: number | null;
  competitors: Competitor[];
}

const sum = (...v: (number | null)[]): number | null => (v.every((x) => x === null) ? null : v.reduce<number>((a, x) => a + (x ?? 0), 0));

export const competitors: ServiceDefinition<Input, CompetitorsOutput> = {
  id: cfg.id,
  name: cfg.name,
  summary: `Up to ${cfg.maxResults} organic search competitors of a domain with ranking overlap and traffic metrics (DataForSEO Labs Competitors Domain). Use it to find who competes with a domain; use keyword_gap to see which keywords a known competitor ranks for that you do not.`,
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
    total_available: 993,
    competitors: [
      {
        domain: "competitor.com",
        intersections: 115,
        avg_position: 13.84,
        domain_metrics: { organic_keywords: 151000, organic_traffic_estimate: 820000.5, organic_traffic_value_usd: 1200000.25, paid_keywords: 4 },
        shared_keyword_metrics: { organic_keywords: 115, organic_traffic_estimate: 4100.2, organic_traffic_value_usd: 9000.5, top3_keywords: 12, top10_keywords: 40 },
      },
    ],
  },

  estimateCostUsd: () => DFS_PRICES.labsPerTask + cfg.maxResults * DFS_PRICES.labsPerItem,

  buildRequest: (i) => [
    { target: i.domain, location_code: i.location_code, language_code: i.language_code, limit: cfg.maxResults, include_clickstream_data: false },
  ],

  mapResult(task, i) {
    const r = obj(arr(task.result)[0]);
    const competitors = arr(r.items)
      .slice(0, cfg.maxResults)
      .map((raw): Competitor => {
        const item = obj(raw);
        const full = obj(obj(item.full_domain_metrics).organic);
        const fullPaid = obj(obj(item.full_domain_metrics).paid);
        const shared = obj(obj(item.metrics).organic);
        return {
          domain: str(item.domain),
          intersections: num(item.intersections),
          avg_position: round2(num(item.avg_position)),
          domain_metrics: {
            organic_keywords: num(full.count),
            organic_traffic_estimate: round2(num(full.etv)),
            organic_traffic_value_usd: round2(num(full.estimated_paid_traffic_cost)),
            paid_keywords: num(fullPaid.count),
          },
          shared_keyword_metrics: {
            organic_keywords: num(shared.count),
            organic_traffic_estimate: round2(num(shared.etv)),
            organic_traffic_value_usd: round2(num(shared.estimated_paid_traffic_cost)),
            top3_keywords: sum(num(shared.pos_1), num(shared.pos_2_3)),
            top10_keywords: sum(num(shared.pos_1), num(shared.pos_2_3), num(shared.pos_4_10)),
          },
        };
      });
    return {
      target: i.domain,
      location_code: i.location_code,
      language_code: i.language_code,
      total_available: num(r.total_count),
      competitors,
    };
  },
};
