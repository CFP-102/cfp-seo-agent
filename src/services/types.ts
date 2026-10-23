import type { z } from "zod";
import type { DfsTask } from "../dataforseo/client.js";

/**
 * One sellable API. Everything commercial (price, limits, cost ceiling, cache TTL,
 * on/off switch) lives in src/config/services.ts; this type is the contract every
 * adapter implements so payment, cost guard, cache and MCP treat all services alike.
 */
export interface ServiceDefinition<I = any, O = any> {
  id: string;
  name: string;
  summary: string;
  route: string;
  /** Selling price in USDC as a decimal string, e.g. "0.05". */
  priceUsdc: string;
  enabled: boolean;
  cacheTtlSeconds: number;
  limits: { maxInputs: number; maxResults: number };
  upstream: {
    /** DataForSEO path, e.g. /v3/keywords_data/google_ads/search_volume/live */
    endpoint: string;
    /** Hard ceiling. A request whose worst-case estimate exceeds this is refused before payment. */
    maxCostUsd: number;
  };
  inputSchema: z.ZodType<I>;
  /** Pre-payment semantic check (e.g. supported location/language pair). Returns an error message or null. */
  validateInput?(input: I): string | null;
  /** Worst-case upstream cost in USD for this input, computed from the published price list. */
  estimateCostUsd(input: I): number;
  /** Body sent to DataForSEO (an array of task objects). */
  buildRequest(input: I): unknown[];
  /** Map one DataForSEO task into our public output. Must cap list lengths at limits.maxResults. */
  mapResult(task: DfsTask, input: I): O;
  /**
   * Packages only: further upstream calls made for the same payment, after the primary one (buildRequest/upstream.endpoint).
   * The number of calls is fixed and their worst-case cost is part of estimateCostUsd, so a payment still triggers a bounded,
   * known set of upstream calls.
   */
  extraSteps?: { endpoint: string; buildRequest(input: I): unknown[] }[];
  /** Packages only: map all tasks, primary first, then extraSteps in order. */
  mapPackage?(tasks: DfsTask[], input: I): O;
  /** Shown next to results, e.g. "AI search volumes are modeled estimates". */
  notice?: string;
  example: I;
  /** Small illustrative response (documentation only; kept in sync with mapResult by a test). */
  outputExample: O;
}

export interface ServiceResponse<O> {
  request_id: string;
  service: string;
  data_source: "sandbox" | "live";
  cached: boolean;
  notice?: string;
  result: O;
}
