import type { Env } from "./config/env.js";
import type { Pipeline } from "./services/pipeline.js";
import { toolNameOf } from "./services/common.js";

/** Public, free description of what we sell. Used by GET /api/v1/services and the MCP list_services tool. */
export function buildCatalog(deps: { env: Env; pipeline: Pipeline; network?: string; freeSample?: Record<string, unknown> }) {
  const { env, pipeline } = deps;
  return {
    data_source: pipeline.dataSource,
    payments: env.PAYMENT_MODE,
    ...(deps.network ? { network: deps.network, asset: "USDC" } : {}),
    ...(deps.freeSample ? { free_sample: deps.freeSample } : {}),
    services: pipeline.services.map((s) => ({
      id: s.id,
      name: s.name,
      summary: s.summary,
      method: "POST",
      path: s.route,
      mcp_tool: toolNameOf(s.id),
      price_usdc: s.priceUsdc,
      enabled: pipeline.isEnabled(s),
      max_inputs: s.limits.maxInputs,
      max_results: s.limits.maxResults,
      ...(s.notice ? { notice: s.notice } : {}),
      example_request: s.example,
    })),
  };
}
