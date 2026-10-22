import { z } from "zod";
import { DFS_PRICES, serviceConfig } from "../config/services.js";
import type { ServiceDefinition } from "./types.js";
import { arr, domainString, localeValidator, num, obj, round2, withLocale } from "./common.js";

const cfg = serviceConfig("domain-overview");

const input = withLocale({ domain: domainString });
type Input = z.output<typeof input>;

export interface DomainOverviewOutput {
  target: string;
  location_code: number;
  language_code: string;
  organic: {
    keywords_count: number | null;
    /** Estimated monthly organic visits (DataForSEO "etv"). */
    estimated_monthly_traffic: number | null;
    /** What that traffic would cost to buy via ads, USD per month. */
    traffic_value_usd: number | null;
    /** Number of keywords by Google position bucket. */
    positions: { top_1: number | null; top_2_3: number | null; top_4_10: number | null; top_11_20: number | null; top_21_100: number | null };
    /** Change versus the previous update. */
    changes: { new: number | null; up: number | null; down: number | null; lost: number | null };
  };
  paid: { keywords_count: number | null; estimated_monthly_traffic: number | null; traffic_cost_usd: number | null };
}

const sum = (...v: (number | null)[]): number | null => (v.every((x) => x === null) ? null : v.reduce<number>((a, x) => a + (x ?? 0), 0));

export const domainOverview: ServiceDefinition<Input, DomainOverviewOutput> = {
  id: cfg.id,
  name: cfg.name,
  summary: "Organic and paid search footprint of a domain: keyword count, estimated traffic, traffic value and ranking distribution (DataForSEO Labs Domain Rank Overview).",
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
    organic: {
      keywords_count: 8806,
      estimated_monthly_traffic: 31087.25,
      traffic_value_usd: 183134.65,
      positions: { top_1: 42, top_2_3: 145, top_4_10: 1120, top_11_20: 2103, top_21_100: 5396 },
      changes: { new: 7167, up: 883, down: 575, lost: 4363 },
    },
    paid: { keywords_count: 0, estimated_monthly_traffic: 0, traffic_cost_usd: 0 },
  },

  estimateCostUsd: () => DFS_PRICES.labsPerTask + cfg.maxResults * DFS_PRICES.labsPerItem,

  buildRequest: (i) => [{ target: i.domain, location_code: i.location_code, language_code: i.language_code }],

  mapResult(task, i) {
    const r = obj(arr(task.result)[0]);
    const metrics = obj(obj(arr(r.items)[0]).metrics);
    const o = obj(metrics.organic);
    const p = obj(metrics.paid);
    return {
      target: i.domain,
      location_code: i.location_code,
      language_code: i.language_code,
      organic: {
        keywords_count: num(o.count),
        estimated_monthly_traffic: round2(num(o.etv)),
        traffic_value_usd: round2(num(o.estimated_paid_traffic_cost)),
        positions: {
          top_1: num(o.pos_1),
          top_2_3: num(o.pos_2_3),
          top_4_10: num(o.pos_4_10),
          top_11_20: num(o.pos_11_20),
          top_21_100: sum(num(o.pos_21_30), num(o.pos_31_40), num(o.pos_41_50), num(o.pos_51_60), num(o.pos_61_70), num(o.pos_71_80), num(o.pos_81_90), num(o.pos_91_100)),
        },
        changes: { new: num(o.is_new), up: num(o.is_up), down: num(o.is_down), lost: num(o.is_lost) },
      },
      paid: { keywords_count: num(p.count), estimated_monthly_traffic: round2(num(p.etv)), traffic_cost_usd: round2(num(p.estimated_paid_traffic_cost)) },
    };
  },
};
