import type { Request, RequestHandler, Response } from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Env } from "../config/env.js";
import { buildCatalog } from "../catalog.js";
import { log } from "../lib/log.js";
import type { Store } from "../lib/store.js";
import { inputJsonSchema, toolNameOf } from "../services/common.js";
import type { Pipeline, Prepared } from "../services/pipeline.js";
import type { ServiceDefinition } from "../services/types.js";
import { toolResult, type McpCall } from "../payments/x402.js";
import type { FreeSample } from "../freeSample.js";
import type { Wishlist } from "../wishlist.js";
import { searchDachLocations } from "../config/locales.js";

export const MCP_SERVER_NAME = "agent-data-api";
export const MCP_SERVER_VERSION = "0.1.0";

export interface McpDeps {
  env: Env;
  store: Store;
  pipeline: Pipeline;
  /** Absent only in sandbox development mode (no payment). */
  payments?: { network: string; mcp: { callPaidTool: McpCall } };
  freeSample?: FreeSample;
  wishlist?: Wishlist;
}

const FREE_TOOLS: Tool[] = [
  {
    name: "list_services",
    description: "FREE. List all paid data services with price in USDC, limits, notices and example requests. Call this first.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { title: "List services", readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "preflight",
    description:
      "FREE. Validate an input for a paid tool and check budget/limits without paying or calling any data provider. " +
      "Returns the normalized input. Use it before a paid call to avoid wasted payments.",
    inputSchema: {
      type: "object",
      properties: {
        service: { type: "string", description: "Service id, e.g. keyword-metrics (see list_services)." },
        input: { type: "object", description: "The same arguments you would send to the paid tool." },
      },
      required: ["service", "input"],
      additionalProperties: false,
    },
    annotations: { title: "Preflight check", readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "free_sample",
    description:
      "FREE (when enabled): try a service without paying. Either one keyword-metrics lookup for ONE keyword (send keyword), " +
      "or one call of any service up to 0.05 USDC (send service and input, the same arguments as the paid tool). " +
      "One per service per day per client and a daily total; returns an error when used up. Packages have no sample.",
    inputSchema: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "Legacy keyword-metrics sample: one keyword, up to 60 characters." },
        service: { type: "string", description: "Service id for a per-service sample, e.g. google-serp (see list_services, field free_sample)." },
        input: { type: "object", description: "Arguments for that service, same as the paid tool." },
        location_code: { type: "integer", description: "Country code, default 2840 (United States)." },
        language_code: { type: "string", description: "Language code such as en or de." },
      },
      additionalProperties: false,
    },
    annotations: { title: "Free sample", readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "find_location",
    description:
      "FREE. Look up city/region location codes in Germany, Austria and Switzerland (e.g. Rosenheim, Wien, Zürich). These codes work for google_serp, local_business, news_search, image_search and local_market_check; all other tools take country codes (2276, 2040, 2756).",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Part of the place name, at least 2 characters.", minLength: 2, maxLength: 60 }, country: { type: "string", enum: ["DE", "AT", "CH"] } },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: { title: "Find a location code", readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "wishlist",
    description:
      "FREE. Tell the operator which data tool you would pay for (one short text, 10 to 300 characters, no personal data). Write-only: nothing is published and no reply is sent. Limited to 3 per day per client.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "Which data tool would you pay for, and roughly what for?", minLength: 10, maxLength: 300 } },
      required: ["text"],
      additionalProperties: false,
    },
    annotations: { title: "Request a tool", readOnlyHint: false, openWorldHint: false },
  },
  {
    name: "get_result",
    description: "FREE. Fetch a result you already paid for (or its status) with the request_id and result_token from the original response.",
    inputSchema: {
      type: "object",
      properties: { request_id: { type: "string" }, result_token: { type: "string" } },
      required: ["request_id", "result_token"],
      additionalProperties: false,
    },
    annotations: { title: "Get paid result", readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "retry_request",
    description:
      "FREE. If a PAID call failed at the data provider after payment was settled, re-run it once at no extra charge " +
      "using request_id and result_token from the error response.",
    inputSchema: {
      type: "object",
      properties: { request_id: { type: "string" }, result_token: { type: "string" } },
      required: ["request_id", "result_token"],
      additionalProperties: false,
    },
    annotations: { title: "Retry failed paid request", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
];

function paidTool(s: ServiceDefinition, deps: McpDeps): Tool {
  const payNote = deps.payments
    ? `PAID: ${s.priceUsdc} USDC per call (USDC on ${deps.payments.network}, x402 v2). ` +
      `Requires an x402-capable MCP client that attaches the payment in _meta["x402/payment"] (e.g. createx402MCPClient from @x402/mcp). ` +
      `Without a payment this tool returns a "payment required" result and charges nothing.`
    : "SANDBOX (development): returns dummy data, no payment.";
  return {
    name: toolNameOf(s.id),
    description: `${s.summary} ${payNote}${s.notice ? ` NOTE: ${s.notice}` : ""}`,
    inputSchema: inputJsonSchema(s.inputSchema) as Tool["inputSchema"],
    annotations: { title: s.name, readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  };
}

const text = (body: Record<string, unknown>, isError = false): CallToolResult => toolResult(body, isError);

export function createMcpServer(deps: McpDeps, clientId = "unknown"): Server {
  const { pipeline, store } = deps;
  const server = new Server(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        "Pay-per-call SEO data tools. Call list_services for prices. Paid tools need an x402-capable client (USDC on Base); " +
        "free tools (list_services, preflight, find_location, free_sample, wishlist, get_result, retry_request) need no payment. Inputs are validated before any payment is requested. " +
        `For businesses only (B2B): a paid call confirms that you act as a business and accept the terms of use at ${deps.env.PUBLIC_BASE_URL}/legal.html#terms.`,
    },
  );

  const byTool = (name: string) => pipeline.services.find((s) => toolNameOf(s.id) === name && pipeline.isEnabled(s));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...FREE_TOOLS.filter((t) => t.name !== "free_sample" || deps.freeSample?.enabled()), ...pipeline.services.filter((s) => pipeline.isEnabled(s)).map((s) => paidTool(s, deps))],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const { name } = request.params;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const meta = request.params._meta as Record<string, unknown> | undefined;

    switch (name) {
      case "list_services":
        return text(buildCatalog({ env: deps.env, pipeline, network: deps.payments?.network }));

      case "preflight": {
        const service = pipeline.services.find((s) => s.id === args.service);
        if (!service) return text({ error: "unknown_service", message: `Unknown service. Use one of: ${pipeline.services.map((s) => s.id).join(", ")}` }, true);
        store.bump(service.id, "preflight");
        const prep = pipeline.prepare(service, args.input);
        if (!prep.ok) return text({ ok: false, ...prep.body }, true);
        return text({
          ok: true,
          service: service.id,
          price_usdc: service.priceUsdc,
          normalized_input: prep.prepared.input as Record<string, unknown>,
          message: `Input is valid. Call tool ${toolNameOf(service.id)} with the same arguments to buy it.`,
        });
      }

      case "free_sample": {
        if (!deps.freeSample?.enabled()) return text({ error: "not_found" }, true);
        const out =
          typeof args.service === "string"
            ? await deps.freeSample.runService(clientId, args.service, args.input)
            : await deps.freeSample.run(clientId, { keyword: args.keyword, location_code: args.location_code, language_code: args.language_code });
        return text(out.body, out.status >= 400);
      }

      case "find_location": {
        const q = typeof args.query === "string" ? args.query.slice(0, 60) : "";
        if (q.trim().length < 2) return text({ error: "invalid_input", message: "query needs at least 2 characters" }, true);
        const country = typeof args.country === "string" && /^(DE|AT|CH)$/i.test(args.country) ? args.country : undefined;
        return text({ locations: searchDachLocations(q, country).map((l) => ({ location_code: l.location_code, name: l.name, type: l.type, country_iso_code: l.country_iso_code })) });
      }

      case "wishlist": {
        if (!deps.wishlist) return text({ error: "not_found" }, true);
        const out = deps.wishlist.run(clientId, args);
        return text(out.body, out.status >= 400);
      }

      case "get_result": {
        const out = pipeline.lookup(String(args.request_id ?? ""), typeof args.result_token === "string" ? args.result_token : undefined);
        return text(out.body as Record<string, unknown>, out.status >= 400);
      }

      case "retry_request": {
        const out = await pipeline.retry(String(args.request_id ?? ""), typeof args.result_token === "string" ? args.result_token : undefined);
        return text(out.body as Record<string, unknown>, out.status >= 400);
      }
    }

    const service = byTool(name);
    if (!service) return text({ error: "unknown_tool", message: `Unknown or disabled tool "${name}". Call list_services.` }, true);

    store.bump(service.id, "request");
    const prep = pipeline.prepare(service, args);
    if (!prep.ok) {
      store.bump(service.id, `refused_${prep.body.error}`);
      // Refused BEFORE any payment challenge: a client can never pay for something we would not serve.
      return text(prep.body as Record<string, unknown>, true);
    }
    if (deps.payments) return deps.payments.mcp.callPaidTool(prep.prepared, args, meta, clientId);
    return runUnpaidSandbox(deps, prep.prepared);
  });

  return server;
}

/** Development without payments: sandbox data only (config/env.ts forbids anything else). */
async function runUnpaidSandbox(deps: McpDeps, prepared: Prepared): Promise<CallToolResult> {
  const { pipeline, env } = deps;
  if (env.PAYMENT_MODE !== "off" || pipeline.dataSource !== "sandbox") {
    return text({ error: "payments_unavailable", message: "Payment processing is not configured." }, true);
  }
  const reservation = pipeline.reserve(prepared);
  if ("refusal" in reservation) return text({ error: reservation.refusal.code, message: reservation.refusal.message }, true);
  const claim = pipeline.claim(prepared, null)!;
  try {
    const out = await pipeline.runClaimed(prepared, claim.requestId, claim.resultToken, { paid: false, via: "mcp" });
    return text(out.body, out.status >= 400);
  } finally {
    reservation.release();
  }
}

/**
 * Streamable HTTP endpoint, stateless: every POST gets its own short-lived server + transport, so there is no
 * session state to leak or clean up. JSON responses (no SSE) keep it simple for clients and proxies.
 */
export function createMcpHandler(deps: McpDeps): RequestHandler {
  return async (req: Request, res: Response) => {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return void res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed. Use POST." }, id: null });
    }
    // JSON-RPC batches would multiply the per-request rate limit (up to 100 calls in one POST) and nothing needs them.
    if (Array.isArray(req.body)) {
      return void res.status(400).json({ jsonrpc: "2.0", error: { code: -32600, message: "Batch requests are not supported. Send one message per request." }, id: null });
    }
    const server = createMcpServer(deps, req.ip ?? "unknown");
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      log.error("mcp request failed", { err });
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  };
}
