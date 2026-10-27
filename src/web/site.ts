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
import type { Commerce } from "../commerce/index.js";
import { FINANCE_DIRECTORY } from "../commerce/finance.js";
import { formatBps } from "../commerce/pricing.js";
import { DEFAULT_MARKUP_BPS } from "../config/commerce.js";

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
    ...Object.fromEntries(services.map((s) => [`${s.id.replaceAll("-", "_").toUpperCase()}_PRICE`, escapeHtml(s.priceUsdc)])),
    SERVICE_COUNT: String(services.filter(s => pipeline.isEnabled(s)).length),
    MIN_SERVICE_PRICE: String(Math.min(...services.map(s => Number(s.priceUsdc)))),
    MAX_SERVICE_PRICE: String(Math.max(...services.map(s => Number(s.priceUsdc)))),
    CASE_TOTAL_PRICE: String(Number((Number(serviceConfig("content-month-plan").priceUsdc) + Number(serviceConfig("content-plan-shift").priceUsdc)).toFixed(6))),
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
export function createSiteRouter(deps: { env: Env; pipeline: Pipeline; network?: string; freeSample?: boolean; freeSampleEligible?: string[]; store?: Store; fetchImpl?: typeof fetch; commerce?: Commerce }): Router {
  const { env, pipeline, network } = deps;
  const router = express.Router();
  const read = (name: string) => readFileSync(new URL(name, PUBLIC_DIR), "utf8");
  const templates = { index: read("index.html"), llms: read("llms.txt"), legal: read("legal.html"), legalDe: read("legal-de.html"), guide: read("quickstart.html"), indexDe: read("index-de.html"), agentur: read("agentur-de.html"), agencies: read("agentur-en.html") };

  // Test/sandbox deployments stay out of search engines; only a mainnet (real money) deployment is indexable.
  const indexable = env.PAYMENT_MODE === "mainnet";

  const page = (template: string, type: string, extraValues: () => Record<string, string> = () => ({})): express.RequestHandler => (_req, res) => {
    res.type(type);
    if (!indexable) res.setHeader("X-Robots-Tag", "noindex, nofollow");
    res.setHeader("Cache-Control", "public, max-age=300");
    // The page loads only its own CSS/JS and makes same-origin requests.
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'self'; font-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    res.send(render(template, { ...siteValues(env, pipeline, network), ...extraValues() }));
  };

  router.get(["/", "/index.html"], page(templates.index, "html"));
  router.get(["/de", "/de/", "/index-de.html"], page(templates.indexDe, "html"));
  router.get(["/de/agenturen", "/agenturen", "/agentur-de.html"], page(templates.agentur, "html"));
  router.get(["/agencies", "/agentur-en.html"], page(templates.agencies, "html"));
  router.get("/llms.txt", page(templates.llms, "text/plain; charset=utf-8"));
  router.get("/legal.html", page(templates.legal, "html"));
  router.get("/legal-de.html", page(templates.legalDe, "html"));
  router.get("/quickstart.html", page(templates.guide, "html"));
  router.get(["/connect", "/connect-en.html"], page(read("connect-en.html"), "html"));
  router.get(["/de/einrichten", "/connect-de.html"], page(read("connect-de.html"), "html"));

  for (const lang of ["en", "de"]) {
    const status = () => ({ TASK_STATUS: ["content-month-plan", "content-plan-shift"].every(id => {
      const service = pipeline.services.find(s => s.id === id);
      return service && pipeline.isEnabled(service);
    }) ? "" : `<p class="note">${lang === "de" ? "Mindestens ein Dienst dieses Beispiels ist derzeit nicht verfügbar. Vor einem Kauf den aktuellen Katalog prüfen." : "At least one service in this example is currently unavailable. Check the current catalog before purchasing."}</p>` });
    router.get([lang === "de" ? "/de/content-planung-beispiel" : "/content-planning-example", `/case-study-${lang}.html`], page(read(`case-study-${lang}.html`), "html", status));
  }

  // Content planner app (EN/DE): form, one approved purchase, plan file, date moves and a printable client report.
  for (const lang of ["en", "de"] as const) {
    const status = () => ({ TASK_STATUS: ["content-month-plan", "content-plan-shift"].every((id) => {
      const service = pipeline.services.find((s) => s.id === id);
      return service && pipeline.isEnabled(service);
    }) ? "" : `<p class="note">${lang === "de" ? "Mindestens ein Dienst des Planers ist derzeit nicht verfügbar. Kein Kauf möglich." : "At least one planner service is currently unavailable. No purchase possible."}</p>` });
    router.get([lang === "de" ? "/de/planer" : "/planner", `/planner-${lang}.html`], page(read(`planner-${lang}.html`), "html", status));
  }

  // Video project planner app (EN/DE): one job from a form, one approved purchase, calendar file and client report.
  for (const lang of ["en", "de"] as const) {
    const service = pipeline.services.find((s) => s.id === "video-project-plan");
    const status = () => ({ TASK_STATUS: service && pipeline.isEnabled(service) ? "" : `<p class="note">${lang === "de" ? "Dieser Dienst ist derzeit nicht verfügbar. Kein Kauf möglich." : "This service is currently unavailable. No purchase possible."}</p>` });
    router.get([lang === "de" ? "/de/projekt-planer" : "/project-planner", `/project-planner-${lang}.html`], page(read(`project-planner-${lang}.html`), "html", status));
  }

  // Focused human entry points. They describe one purchase and never run a data call.
  for (const [slug, germanSlug, serviceId] of [
    ["keyword-research", "keyword-recherche", "keyword-metrics"],
    ["local-visibility", "lokale-sichtbarkeit", "local-market-check"],
    ["content-planning", "content-planung", "content-month-plan"],
  ]) {
    for (const lang of ["en", "de"]) {
      const service = pipeline.services.find((s) => s.id === serviceId);
      if (!service) continue;
      const status = () => ({ TASK_STATUS: pipeline.isEnabled(service) ? "" : `<p class="note">${lang === "de" ? "Dieser Dienst ist derzeit nicht verfügbar. Nicht kaufen; aktuellen Katalog prüfen." : "This service is currently unavailable. Do not purchase; check the current catalog."}</p>` });
      router.get([lang === "de" ? `/de/${germanSlug}` : `/${slug}`, `/task-${slug}-${lang}.html`], page(read(`task-${slug}-${lang}.html`), "html", status));
    }
  }

  // Agent Commerce pages (EN/DE). Gift cards show their live switch state; the finance page lists the directory.
  const financeCards = () =>
    `<div class="grid">${FINANCE_DIRECTORY.map((e) => `<article class="card"><h3>${escapeHtml(e.name)}</h3><p>${escapeHtml(e.summary)}</p>${e.products.map((p) => `<p><strong>${escapeHtml(p.name)}</strong> · ${escapeHtml(p.regions.join(", "))}<br><span class="fine">${escapeHtml(p.pricing)}</span></p>`).join("")}<div class="meta"><span>${escapeHtml(e.payment.protocol)} · ${escapeHtml(e.payment.assets.join(", "))} · ${escapeHtml(e.payment.networks.join(", "))}</span><span>${escapeHtml(e.regulatory_note)}</span><span><a href="${escapeHtml(e.website)}" rel="nofollow noopener">${escapeHtml(e.website)}</a> · checked ${escapeHtml(e.last_checked)} · no partnership</span></div></article>`).join("")}</div>`;
  for (const lang of ["en", "de"] as const) {
    const giftcardValues = () => {
      const info = deps.commerce?.giftcards.info();
      const de = lang === "de";
      const state = !info?.enabled
        ? de ? "In Vorbereitung: Derzeit sind keine Käufe möglich. Die Endpunkte antworten mit 503." : "In preparation: no purchases are possible at the moment. The endpoints answer 503."
        : info.paused
          ? de ? "Neue Käufe sind derzeit pausiert." : "New purchases are paused at the moment."
          : info.test_mode
            ? de ? "Testbetrieb: fiktive Testprodukte mit wertlosen Codes, keine echten Gutscheine." : "Test operation: fictional test products with worthless codes, no real gift cards."
            : "";
      return { GIFTCARDS_STATUS: state ? `<p class="note">${escapeHtml(state)}</p>` : "", GIFTCARDS_MARKUP: escapeHtml(formatBps(deps.commerce?.cstore.markupBps() ?? DEFAULT_MARKUP_BPS).replace(".", de ? "," : ".")) };
    };
    router.get([lang === "de" ? "/de/gutscheine" : "/giftcards", `/giftcards-${lang}.html`], page(read(`giftcards-${lang}.html`), "html", giftcardValues));
    router.get([lang === "de" ? "/de/finanzen" : "/finance", `/finance-${lang}.html`], page(read(`finance-${lang}.html`), "html", () => ({ FINANCE_CARDS: financeCards() })));
  }

  router.get("/robots.txt", (_req, res) => {
    res
      .type("text/plain")
      .send(indexable ? `User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/\nSitemap: ${env.PUBLIC_BASE_URL}/sitemap.xml\n` : `User-agent: *\nDisallow: /\n`);
  });

  router.get("/sitemap.xml", (_req, res) => {
    const paths = ["/", "/de/", "/agencies", "/de/agenturen", "/connect", "/de/einrichten", "/quickstart.html", "/status", "/de/status", "/keyword-research", "/de/keyword-recherche", "/local-visibility", "/de/lokale-sichtbarkeit", "/content-planning", "/de/content-planung", "/content-planning-example", "/de/content-planung-beispiel", "/planner", "/de/planer", "/project-planner", "/de/projekt-planer", "/giftcards", "/de/gutscheine", "/finance", "/de/finanzen"];
    if (!indexable) res.setHeader("X-Robots-Tag", "noindex, nofollow");
    res.setHeader("Cache-Control", "public, max-age=300");
    res.type("application/xml").send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${paths.map(path => `<url><loc>${escapeHtml(env.PUBLIC_BASE_URL + path)}</loc></url>`).join("")}</urlset>`);
  });

  router.get("/openapi.json", (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json(buildOpenApi({ env, pipeline, network, freeSample: deps.freeSample, giftcards: deps.commerce?.giftcards.enabled }));
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
