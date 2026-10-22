import { z } from "zod";
import { DFS_PRICES, serviceConfig } from "../config/services.js";
import type { ServiceDefinition } from "./types.js";
import { arr, domainString, localeValidator, num, obj, round2, str, withLocale } from "./common.js";

const cfg = serviceConfig("traffic-estimate");

const domainList = z
  .array(domainString)
  .min(1, "at least one domain is required")
  .max(cfg.maxInputs, `at most ${cfg.maxInputs} domains per request`)
  .transform((list) => [...new Set(list)])
  .describe(`Domains to estimate: 1 to ${cfg.maxInputs} entries, e.g. example.com. Duplicates removed.`);

const input = withLocale({ domains: domainList });
type Input = z.output<typeof input>;

export interface DomainTraffic {
  domain: string;
  /** Estimated monthly organic visits from Google. */
  organic_traffic: number | null;
  organic_keywords: number | null;
  /** Estimated monthly paid visits from Google Ads. */
  paid_traffic: number | null;
  paid_keywords: number | null;
}

export interface TrafficEstimateOutput {
  location_code: number;
  language_code: string;
  domains: DomainTraffic[];
  /** Requested domains DataForSEO returned nothing for. */
  not_found: string[];
}

export const trafficEstimate: ServiceDefinition<Input, TrafficEstimateOutput> = {
  id: cfg.id,
  name: cfg.name,
  summary: `Estimated monthly organic and paid Google traffic for up to ${cfg.maxInputs} domains in one call (DataForSEO Labs Bulk Traffic Estimation).`,
  route: cfg.route,
  priceUsdc: cfg.priceUsdc,
  enabled: cfg.enabled,
  cacheTtlSeconds: cfg.cacheTtlSeconds,
  limits: { maxInputs: cfg.maxInputs, maxResults: cfg.maxResults },
  upstream: { endpoint: cfg.dataforseoEndpoint, maxCostUsd: cfg.maxUpstreamCostUsd },
  inputSchema: input,
  validateInput: localeValidator("labs"),
  example: { domains: ["example.com", "example.org"], location_code: 2840, language_code: "en" },
  outputExample: {
    location_code: 2840,
    language_code: "en",
    domains: [{ domain: "example.com", organic_traffic: 77640808.07, organic_keywords: 3227132, paid_traffic: 37.46, paid_keywords: 14 }],
    not_found: [],
  },

  // Billed per returned domain.
  estimateCostUsd: (i) => DFS_PRICES.labsPerTask + i.domains.length * DFS_PRICES.labsPerItem,

  buildRequest: (i) => [{ targets: i.domains, location_code: i.location_code, language_code: i.language_code }],

  mapResult(task, i) {
    const r = obj(arr(task.result)[0]);
    const domains = arr(r.items)
      .slice(0, cfg.maxResults)
      .map((raw): DomainTraffic => {
        const item = obj(raw);
        const m = obj(item.metrics);
        const o = obj(m.organic);
        const p = obj(m.paid);
        return {
          domain: str(item.target) ?? "",
          organic_traffic: round2(num(o.etv)),
          organic_keywords: num(o.count),
          paid_traffic: round2(num(p.etv)),
          paid_keywords: num(p.count),
        };
      });
    const got = new Set(domains.map((d) => d.domain.toLowerCase()));
    return { location_code: i.location_code, language_code: i.language_code, domains, not_found: i.domains.filter((d) => !got.has(d)) };
  },
};
