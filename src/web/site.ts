import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import express, { type Router } from "express";
import type { Env } from "../config/env.js";
import { buildOpenApi } from "../discovery/openapi.js";
import { toolNameOf } from "../services/common.js";
import type { Pipeline } from "../services/pipeline.js";
import type { ServiceDefinition } from "../services/types.js";

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

export function siteValues(env: Env, pipeline: Pipeline, network?: string): Record<string, string> {
  const services = pipeline.services;
  const modeNote =
    env.PAYMENT_MODE === "testnet"
      ? '<p class="note">Test mode: payments use Base Sepolia test USDC (no real money).' +
        (pipeline.dataSource === "sandbox" ? " Responses contain sandbox dummy data." : "") +
        "</p>"
      : pipeline.dataSource === "sandbox"
        ? '<p class="note">Development mode: responses contain sandbox dummy data.</p>'
        : "";
  return {
    NAME: escapeHtml(env.SITE_NAME),
    BASE_URL: escapeHtml(env.PUBLIC_BASE_URL),
    NETWORK: escapeHtml(network ?? "eip155:8453"),
    MODE_NOTE: modeNote,
    CONTACT_EMAIL: escapeHtml(env.CONTACT_EMAIL || "[set CONTACT_EMAIL]"),
    PAY_TO_ADDRESS: escapeHtml(env.PAY_TO_ADDRESS),
    SERP_PRICE: escapeHtml(services.find((s) => s.id === "google-serp")!.priceUsdc),
    SERVICE_CARDS: services.map((s) => card(s, pipeline.isEnabled(s))).join("\n"),
    SERVICE_LINES: services
      .filter((s) => pipeline.isEnabled(s))
      .map((s) => `- ${s.name} (${s.priceUsdc} USDC): POST ${env.PUBLIC_BASE_URL}${s.route} — MCP tool ${toolNameOf(s.id)} — ${s.summary}`)
      .join("\n"),
  };
}

/** Website, llms.txt, OpenAPI document and the optional /.well-known/x402 compatibility file. */
export function createSiteRouter(deps: { env: Env; pipeline: Pipeline; network?: string; freeSample?: boolean }): Router {
  const { env, pipeline, network } = deps;
  const router = express.Router();
  const read = (name: string) => readFileSync(new URL(name, PUBLIC_DIR), "utf8");
  const templates = { index: read("index.html"), llms: read("llms.txt"), legal: read("legal.html"), guide: read("quickstart.html") };

  // Test/sandbox deployments stay out of search engines; only a mainnet (real money) deployment is indexable.
  const indexable = env.PAYMENT_MODE === "mainnet";

  const page = (template: string, type: string): express.RequestHandler => (_req, res) => {
    res.type(type);
    if (!indexable) res.setHeader("X-Robots-Tag", "noindex, nofollow");
    res.setHeader("Cache-Control", "public, max-age=300");
    // The page loads only its own CSS/JS and makes same-origin requests.
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    res.send(render(template, siteValues(env, pipeline, network)));
  };

  router.get(["/", "/index.html"], page(templates.index, "html"));
  router.get("/llms.txt", page(templates.llms, "text/plain; charset=utf-8"));
  router.get("/legal.html", page(templates.legal, "html"));
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
