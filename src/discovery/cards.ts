import type { Env } from "../config/env.js";
import { toolNameOf } from "../services/common.js";
import type { Pipeline } from "../services/pipeline.js";

/**
 * Machine-readable "business cards" for crawlers and agents. They only describe what already exists
 * (REST + OpenAPI, MCP over streamable HTTP, x402 payments); no other protocol is claimed.
 */
export function agentCard(deps: { env: Env; pipeline: Pipeline; network?: string; freeSampleEligible: string[] }) {
  const { env, pipeline } = deps;
  const base = env.PUBLIC_BASE_URL;
  return {
    name: env.SITE_NAME,
    description:
      "Pay-per-call SEO data for AI agents and agencies (focus: Germany, Austria, Switzerland). Keyword, SERP, competitor, domain and local data from DataForSEO. Pay per request in USDC on Base with x402: no account, no API key.",
    url: base,
    version: "1",
    provider: { organization: "Burcleon Europe Limited, Zweigniederlassung Engelsberg (Chiemgau Films)", url: base + "/legal.html#impressum", ...(env.CONTACT_EMAIL ? { email: env.CONTACT_EMAIL } : {}) },
    interfaces: {
      openapi: base + "/openapi.json",
      mcp: { transport: "streamable-http", url: base + "/mcp" },
      llms_txt: base + "/llms.txt",
      catalog: base + "/api/v1/services",
      recipes: base + "/recipes.json",
      status: base + "/status.json",
    },
    payment: { protocol: "x402", version: 2, scheme: "exact", network: deps.network ?? "eip155:8453", asset: "USDC", pay_to: env.PAY_TO_ADDRESS, flow: "pay before delivery" },
    free: { catalog: true, preflight: base + "/api/v1/preflight/{service-id}", sample: base + "/api/v1/free-sample/{service-id}", wishlist: base + "/api/v1/wishlist" },
    data_handling: { server_location: "Germany (Hetzner)", ip_addresses_stored: false, request_data_retention_days: env.RETENTION_DAYS, privacy: base + "/legal.html#datenschutz" },
    terms: base + "/legal.html#terms",
    audience: "Businesses only (B2B)",
    skills: pipeline.services
      .filter((s) => pipeline.isEnabled(s))
      .map((s) => ({
        id: s.id,
        name: s.name,
        description: s.summary,
        price_usdc: s.priceUsdc,
        rest: { method: "POST", url: base + s.route },
        mcp_tool: toolNameOf(s.id),
        free_sample: deps.freeSampleEligible.includes(s.id),
        example_input: s.example,
      })),
  };
}

/** MCP server card (shape follows the draft "server card" proposal: name, version, transport, capabilities, links). */
export function mcpServerCard(env: Env) {
  const base = env.PUBLIC_BASE_URL;
  return {
    serverInfo: { name: "com.chiemgaufilms.agent/agent-data-api", title: env.SITE_NAME, version: "0.1.5" },
    description: "SEO data tools for AI agents. Free tools: list_services, preflight, free_sample, wishlist, get_result, retry_request. Paid tools need an x402-capable MCP client (USDC on Base).",
    transport: { type: "streamable-http", url: base + "/mcp" },
    capabilities: { tools: {} },
    authentication: { required: false, payment: "x402 per paid tool call" },
    documentation: base + "/quickstart.html#mcp",
    websiteUrl: base,
    registry: "https://registry.modelcontextprotocol.io/v0.1/servers?search=com.chiemgaufilms.agent/agent-data-api",
  };
}
