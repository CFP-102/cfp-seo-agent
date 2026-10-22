import type { Env } from "../config/env.js";
import { inputJsonSchema, toolNameOf } from "../services/common.js";
import type { Pipeline } from "../services/pipeline.js";
import type { ServiceDefinition } from "../services/types.js";

export const API_VERSION = "0.1.0";

export interface OpenApiDeps {
  /** True when the free sample route is active. */
  freeSample?: boolean;
  env: Env;
  pipeline: Pipeline;
  /** CAIP-2 network of the payment gate, e.g. eip155:8453. Absent in sandbox development mode. */
  network?: string;
}

const camel = (id: string) => id.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

/** Price metadata in the format payment directories read from OpenAPI (see docs/MARKETPLACES.md). */
function paymentInfo(s: ServiceDefinition) {
  return { price: { mode: "fixed", currency: "USD", amount: Number(s.priceUsdc).toFixed(6) }, protocols: [{ x402: {} }] };
}

const errorResponse = (description: string) => ({
  description,
  content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
});

export function buildOpenApi({ env, pipeline, network, freeSample }: OpenApiDeps): Record<string, unknown> {
  const paid = Boolean(network);
  const proofs = env.OWNERSHIP_PROOFS.split(",").map((p) => p.trim()).filter(Boolean);
  const services = pipeline.services.filter((s) => pipeline.isEnabled(s));

  const payDescription = paid
    ? `Payment: x402 v2, USDC on ${network}. Send the request without payment to receive HTTP 402 with a PAYMENT-REQUIRED header, ` +
      `then retry with a PAYMENT-SIGNATURE header (use an x402 client such as @x402/fetch). No account or API key is needed.`
    : "Development mode: sandbox data, no payment.";

  const paths: Record<string, unknown> = {
    "/api/v1/services": {
      get: {
        operationId: "listServices",
        summary: "List services, prices and limits (free)",
        tags: ["free"],
        security: [],
        responses: { "200": { description: "Service catalog", content: { "application/json": { schema: { type: "object" } } } } },
      },
    },
    ...(freeSample
      ? {
          "/api/v1/free-sample": {
            post: {
              operationId: "freeSample",
              summary: "Free sample: one keyword, no payment (limited)",
              description: "One keyword-metrics lookup for ONE keyword, no payment. Limited to one per day per client and a daily total; returns 429 when used up.",
              tags: ["free"],
              security: [],
              requestBody: {
                required: true,
                content: {
                  "application/json": {
                    schema: { type: "object", properties: { keyword: { type: "string", maxLength: 60 }, location_code: { type: "integer" }, language_code: { type: "string" } }, required: ["keyword"], additionalProperties: false },
                    examples: { default: { value: { keyword: "running shoes" } } },
                  },
                },
              },
              responses: {
                "200": { description: "Sample result (sample: true)", content: { "application/json": { schema: { type: "object" } } } },
                "429": errorResponse("Sample already used today, or today's samples are used up"),
                "400": errorResponse("Invalid input"),
              },
            },
          },
        }
      : {}),
    "/api/v1/wishlist": {
      post: {
        operationId: "wishlist",
        summary: "Tell us which data tool you would pay for (free)",
        description: "Write-only wishlist: one short text (10 to 300 characters, no personal data). Nothing is published and no reply is sent. Limited to 3 per day per client.",
        tags: ["free"],
        security: [],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { type: "object", properties: { text: { type: "string", minLength: 10, maxLength: 300 } }, required: ["text"], additionalProperties: false },
              examples: { default: { value: { text: "Backlink summary for a domain, about 0.05 USDC" } } },
            },
          },
        },
        responses: {
          "200": { description: "Saved", content: { "application/json": { schema: { type: "object" } } } },
          "429": errorResponse("Too many wishes today"),
          "400": errorResponse("Invalid input"),
        },
      },
    },
    "/api/v1/preflight/{serviceId}": {
      post: {
        operationId: "preflight",
        summary: "Validate an input without paying (free)",
        description: "Validates the input exactly like the paid route and checks budget and limits. Never calls the data provider and never charges.",
        tags: ["free"],
        security: [],
        parameters: [{ name: "serviceId", in: "path", required: true, schema: { type: "string", enum: services.map((s) => s.id) } }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
        responses: {
          "200": { description: "Input is valid", content: { "application/json": { schema: { type: "object" } } } },
          "400": errorResponse("Invalid input"),
          "422": errorResponse("Unsupported parameters or cost ceiling"),
          "503": errorResponse("Service disabled or budget exhausted"),
        },
      },
    },
    "/api/v1/results/{requestId}": {
      get: {
        operationId: "getResult",
        summary: "Fetch a paid result again (free, needs the result token)",
        tags: ["free"],
        security: [{ resultToken: [] }],
        parameters: [{ name: "requestId", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "The stored result, or the request status if there is no result yet", content: { "application/json": { schema: { type: "object" } } } },
          "404": errorResponse("Unknown request id or invalid token"),
        },
      },
    },
    "/api/v1/results/{requestId}/retry": {
      post: {
        operationId: "retryRequest",
        summary: "Re-run a paid request that failed at the data provider (free, once)",
        tags: ["free"],
        security: [{ resultToken: [] }],
        parameters: [{ name: "requestId", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "The result", content: { "application/json": { schema: { type: "object" } } } },
          "404": errorResponse("Unknown request id or invalid token"),
          "409": errorResponse("Retry not available"),
        },
      },
    },
  };

  for (const s of services) {
    const requestSchema = inputJsonSchema(s.inputSchema);
    paths[s.route] = {
      post: {
        operationId: camel(s.id),
        summary: `${s.name} (${s.priceUsdc} USDC per call)`,
        description: `${s.summary}${s.notice ? `\n\nNOTE: ${s.notice}` : ""}\n\n${payDescription}\n\nMCP tool: \`${toolNameOf(s.id)}\`.`,
        tags: ["paid"],
        ...(paid ? { "x-payment-info": paymentInfo(s) } : {}),
        requestBody: { required: true, content: { "application/json": { schema: requestSchema, examples: { default: { value: s.example } } } } },
        responses: {
          "200": {
            description: "Result. Keep result_token to re-fetch it later.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ServiceResponse" },
                examples: {
                  default: {
                    value: { request_id: "00000000-0000-0000-0000-000000000000", service: s.id, data_source: "live", cached: false, result: s.outputExample, result_token: "<token>" },
                  },
                },
              },
            },
          },
          ...(paid
            ? {
                "402": {
                  description: "Payment Required",
                  headers: {
                    "PAYMENT-REQUIRED": {
                      description: "Base64-encoded x402 v2 PaymentRequired object: price, asset (USDC), network and payTo.",
                      schema: { type: "string" },
                    },
                  },
                },
              }
            : {}),
          "400": errorResponse("Invalid input. Nothing was charged."),
          "422": errorResponse("Unsupported parameters (e.g. location/language) or cost ceiling. Nothing was charged."),
          "429": errorResponse("Rate limited"),
          "502": errorResponse("Data provider failed after payment. The body contains request_id and result_token for one free retry."),
          "503": errorResponse("Service disabled, budget exhausted or provider busy. Nothing was charged."),
        },
      },
    };
  }

  return {
    openapi: "3.1.0",
    info: {
      title: env.SITE_NAME,
      version: API_VERSION,
      summary: "Pay-per-call SEO data APIs for AI agents",
      description:
        "Keyword, SERP, competitor, intent and AI-demand data from DataForSEO, sold per call for small USDC payments via the x402 protocol. " +
        "No registration. Also available as an MCP server at /mcp.\n\n" +
        "For businesses only (B2B). By calling a paid endpoint you confirm that you act as a business and accept the terms of use (see termsOfService).\n\n" +
        payDescription,
      "x-guidance":
        "Start with GET /api/v1/services (free). Validate inputs with POST /api/v1/preflight/{serviceId} (free). " +
        "Call a paid POST endpoint with an x402 client: the first response is 402 with the price, then retry with the payment. " +
        "location_code is a country-level DataForSEO code (2840 US, 2276 DE, 2826 UK).",
      termsOfService: `${env.PUBLIC_BASE_URL}/legal.html#terms`,
      ...(env.CONTACT_EMAIL ? { contact: { email: env.CONTACT_EMAIL } } : {}),
      "x-mcp": { transport: "streamable-http", url: `${env.PUBLIC_BASE_URL}/mcp` },
    },
    ...(proofs.length ? { "x-discovery": { ownershipProofs: proofs } } : {}),
    servers: [{ url: env.PUBLIC_BASE_URL }],
    tags: [
      { name: "paid", description: "Paid endpoints (x402)" },
      { name: "free", description: "Free helper endpoints" },
    ],
    paths,
    components: {
      securitySchemes: {
        resultToken: { type: "http", scheme: "bearer", description: "The result_token returned with the original paid response." },
      },
      schemas: {
        Error: {
          type: "object",
          properties: { error: { type: "string" }, message: { type: "string" }, issues: { type: "array", items: { type: "object" } } },
          required: ["error"],
        },
        ServiceResponse: {
          type: "object",
          properties: {
            request_id: { type: "string", format: "uuid" },
            service: { type: "string" },
            data_source: { type: "string", enum: ["live", "sandbox"], description: "sandbox = dummy test data" },
            cached: { type: "boolean" },
            notice: { type: "string" },
            result: { type: "object", description: "Service-specific result; see the example." },
            result_token: { type: "string", description: "Secret needed to fetch this result again." },
          },
          required: ["request_id", "service", "data_source", "result"],
        },
      },
    },
  };
}
