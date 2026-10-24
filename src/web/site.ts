import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import express, { type Router } from "express";
import type { Env } from "../config/env.js";
import { agentCard, mcpServerCard } from "../discovery/cards.js";
import { buildOpenApi } from "../discovery/openapi.js";
import type { Store } from "../lib/store.js";
import { createExternalUptime } from "../lib/externalUptime.js";
import { buildStatus } from "./status.js";
import { renderStatusPage } from "./statusPage.js";
import { toolNameOf } from "../services/common.js";
import type { Pipeline } from "../services/pipeline.js";
import type { ServiceDefinition } from "../services/types.js";
import { serviceConfig } from "../config/services.js";

const PUBLIC_DIR = new URL("../../public/", import.meta.url);

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Replace {{KEY}} placeholders. Values are inserted as given: callers escape HTML where needed. */
export function render(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (m, key: string) => (key in values ? values[key]! : m));
}

function limitLabel(s: ServiceDefinition): string {
  const hasKeywords = typeof s.example === "object" && s.example !== null && "keywords" in s.example;
  if (hasKeywords) return `up to ${s.limits.maxInputs} keywords`;
  return s.limits.maxResults > 1 ? `up to ${s.limits.maxResults} results` : "1 input";
}

function card(s: ServiceDefinition, enabled: boolean): string {
  return `    <article class="card" data-id="${escapeHtml(s.id)}" data-enabled="${enabled}">
      <h3>${escapeHtml(s.name)} <span class="price">${escapeHtml(s.priceUsdc)} USDC</span></h3>
      ${s.notice && s.id === "ai-keyword-demand" ? '<span class="badge">estimates</span>' : ""}
      <p>${escapeHtml(s.summary)}</p>
      <div class="meta">
        <span>POST <code>${escapeHtml(s.route)}</code></span>
        <span>MCP tool <code>${escapeHtml(toolNameOf(s.id))}</code></span>
        <span>${escapeHtml(limitLabel(s))} · <span class="state">${enabled ? "available" : "temporarily disabled"}</span></span>
      </div>
    </article>`;
}

/** Website grouping: services for video producers get their own section. */
export const isPlanningService = (s: ServiceDefinition) => serviceConfig(s.id).category === "content";

export function siteValues(env: Env, pipeline: Pipeline, network?: string): Record<string, string> {
  const services = pipeline.services;
  const modeNote =
    env.PAYMENT_MODE === "testnet"
      ? '<p class="note">Test mode: payments use Base Sepolia test USDC (no real money).' +
        (pipeline.dataSource === "sandbox" ? " DataForSEO responses contain sandbox dummy data; local datasets retain their source date." : "") +
        "</p>"
      : pipeline.dataSource === "sandbox"
        ? '<p class="note">Development mode: responses contain sandbox dummy data.</p>'
        : "";
  const line = (s: ServiceDefinition) => `- ${s.name} (${s.priceUsdc} USDC): POST ${env.PUBLIC_BASE_URL}${s.route} — MCP tool ${toolNameOf(s.id)} — ${s.summary}`;
  return {
    NAME: escapeHtml(env.SITE_NAME),
    BASE_URL: escapeHtml(env.PUBLIC_BASE_URL),
    NETWORK: escapeHtml(network ?? "eip155:8453"),
    MODE_NOTE: modeNote,
    CONTACT_EMAIL: escapeHtml(env.CONTACT_EMAIL || "[set CONTACT_EMAIL]"),
    PAY_TO_ADDRESS: escapeHtml(env.PAY_TO_ADDRESS),
    SERP_PRICE: escapeHtml(services.find((s) => s.id === "google-serp")!.priceUsdc),
    SERVICE_CARDS: services.filter((s) => !isPlanningService(s)).map((s) => card(s, pipeline.isEnabled(s))).join("\n"),
    SERVICE_CARDS_CONTENT: services.filter(isPlanningService).map((s) => card(s, pipeline.isEnabled(s))).join("\n"),
    SERVICE_LINES: services
      .filter((s) => pipeline.isEnabled(s) && !isPlanningService(s))
      .map(line)
      .join("\n"),
    SERVICE_LINES_CONTENT: services.filter((s) => pipeline.isEnabled(s) && isPlanningService(s)).map(line).join("\n"),
  };
}

/** Website, llms.txt, OpenAPI document and the optional /.well-known/x402 compatibility file. */
export function createSiteRouter(deps: { env: Env; pipeline: Pipeline; network?: string; freeSample?: boolean; freeSampleEligible?: string[]; store?: Store; fetchImpl?: typeof fetch }): Router {
  const { env, pipeline, network } = deps;
  const router = express.Router();
  const read = (name: string) => readFileSync(new URL(name, PUBLIC_DIR), "utf8");
  const templates = { index: read("index.html"), llms: read("llms.txt"), legal: read("legal.html"), legalDe: read("legal-de.html"), guide: read("quickstart.html"), indexDe: read("index-de.html"), agentur: read("agentur-de.html"), agencies: read("agentur-en.html") };

  // Test/sandbox deployments stay out of search engines; only a mainnet (real money) deployment is indexable.
  const indexable = env.PAYMENT_MODE === "mainnet";

  const page = (template: string, type: string): express.RequestHandler => (_req, res) => {
    res.type(type);
    if (!indexable) res.setHeader("X-Robots-Tag", "noindex, nofollow");
    res.setHeader("Cache-Control", "public, max-age=300");
    // The page loads only its own CSS/JS and makes same-origin requests.
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'self'; font-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    res.send(render(template, siteValues(env, pipeline, network)));
  };

  router.get(["/", "/index.html"], page(templates.index, "html"));
  router.get(["/de", "/de/", "/index-de.html"], page(templates.indexDe, "html"));
  router.get(["/de/agenturen", "/agenturen", "/agentur-de.html"], page(templates.agentur, "html"));
  router.get(["/agencies", "/agentur-en.html"], page(templates.agencies, "html"));
  router.get("/llms.txt", page(templates.llms, "text/plain; charset=utf-8"));
  router.get("/legal.html", page(templates.legal, "html"));
  router.get("/legal-de.html", page(templates.legalDe, "html"));
  router.get("/quickstart.html", page(templates.guide, "html"));

  router.get("/robots.txt", (_req, res) => {
    res
      .type("text/plain")
      .send(indexable ? `User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/\n` : `User-agent: *\nDisallow: /\n`);
  });

  router.get("/openapi.json", (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json(buildOpenApi({ env, pipeline, network, freeSample: deps.freeSample }));
  });

  // Status and trust page (EN/DE) plus its JSON. Aggregates only.
  if (deps.store) {
    const store = deps.store;
    const external = env.UPTIMEROBOT_API_KEY ? createExternalUptime({ apiKey: env.UPTIMEROBOT_API_KEY, fetchImpl: deps.fetchImpl }) : null;
    const statusPage = (lang: "en" | "de"): express.RequestHandler => async (_req, res) => {
      res.setHeader("Cache-Control", "public, max-age=60");
      res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
      if (!indexable) res.setHeader("X-Robots-Tag", "noindex, nofollow");
      const v = siteValues(env, pipeline, network);
      const ext = external ? await external.get() : null;
      res.type("html").send(renderStatusPage(buildStatus(store, pipeline), lang, { NAME: v.NAME!, BASE_URL: v.BASE_URL!, CONTACT_EMAIL: v.CONTACT_EMAIL!, PAY_TO_ADDRESS: v.PAY_TO_ADDRESS!, EXTERNAL_STATUS_URL: env.EXTERNAL_STATUS_URL, NETWORK: network }, ext));
    };
    router.get(["/status", "/status.html"], statusPage("en"));
    router.get(["/de/status", "/de/status.html"], statusPage("de"));
    router.get("/status.json", async (_req, res) => {
      res.setHeader("Cache-Control", "public, max-age=60");
      const ext = external ? await external.get() : null;
      res.json({ ...buildStatus(store, pipeline), ...(ext ? { independent: ext } : {}) });
    });
  }

  // Machine-readable business cards for agents and crawlers.
  const cardJson = (build: () => unknown): express.RequestHandler => (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=300");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json(build());
  };
  router.get(["/.well-known/agent.json", "/agent.json"], cardJson(() => agentCard({ env, pipeline, network, freeSampleEligible: deps.freeSampleEligible ?? [] })));
  router.get(["/.well-known/mcp/server-card.json", "/.well-known/mcp.json"], cardJson(() => mcpServerCard(env)));

  // Optional compatibility file (x402scan documents this shape, but its current crawler reads /openapi.json only).
  router.get("/.well-known/x402", (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json({
      version: 1,
      resources: pipeline.services.filter((s) => pipeline.isEnabled(s)).map((s) => `${env.PUBLIC_BASE_URL}${s.route}`),
      instructions: `OpenAPI: ${env.PUBLIC_BASE_URL}/openapi.json · MCP: ${env.PUBLIC_BASE_URL}/mcp · llms.txt: ${env.PUBLIC_BASE_URL}/llms.txt`,
    });
  });

  // Verification files that listing directories ask for. Served only if configured; contents come from the operator's .env.
  const verification: [string, string, string][] = [
    ["/.well-known/402index-verify.txt", env.WELLKNOWN_402INDEX, "text/plain; charset=utf-8"],
    ["/.well-known/mcp-registry-auth", env.WELLKNOWN_MCP_REGISTRY_AUTH, "text/plain; charset=utf-8"],
    ["/.well-known/glama.json", env.WELLKNOWN_GLAMA, "application/json; charset=utf-8"],
  ];
  for (const [path, value, type] of verification) {
    if (!value) continue;
    router.get(path, (_req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.type(type).send(value);
    });
  }

  router.use(express.static(fileURLToPath(PUBLIC_DIR), { index: false, dotfiles: "deny", maxAge: "5m", extensions: [] }));
  return router;
}
