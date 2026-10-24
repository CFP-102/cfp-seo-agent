import { z } from "zod";
import { serviceConfig, WEBSITE_CHECK_LIMITS as limits } from "../config/services.js";
import { createPublicProbe, type Probe, type ProbeResult } from "../lib/webProbe.js";
import { arr, obj } from "./common.js";
import { pageUrl } from "./pageUrl.js";
import type { ServiceDefinition } from "./types.js";

const cfg = serviceConfig("website-check");
const httpsPage = pageUrl.refine(value => new URL(value).protocol === "https:", "HTTPS is required for certificate checks");
const inputSchema = z.strictObject({
  url: httpsPage.describe("One public HTTPS page to check."),
  link_urls: z.array(httpsPage).length(limits.links).describe("Exactly two distinct HTTPS URLs on the same origin to check, e.g. links from website-content. No automatic crawling."),
}).superRefine((i, ctx) => {
  const origin = new URL(i.url).origin;
  const urls = [i.url, origin + "/sitemap.xml", ...i.link_urls];
  if (i.link_urls.some(url => new URL(url).origin !== origin)) ctx.addIssue({ code: "custom", path: ["link_urls"], message: "Links must have the same HTTPS origin as url" });
  if (new Set(urls).size !== limits.requests) ctx.addIssue({ code: "custom", path: ["link_urls"], message: "Page, sitemap and links must be distinct URLs" });
});
type Input = z.output<typeof inputSchema>;

function linkState(probe: ProbeResult) {
  if (probe.outcome !== "response") return "not_checked";
  const status = probe.status ?? 0;
  if (status === 404 || status === 410) return "broken";
  if (status >= 200 && status < 300) return "reachable";
  if (status >= 300 && status < 400) return "redirect";
  if (status === 401 || status === 403) return "restricted";
  if (status === 405 || status === 501) return "head_not_supported";
  if (status >= 500) return "server_error";
  return "other_response";
}
/** Identify the outer sitemap element without executing XML entities or claiming full XML validity. */
export function sitemapFormat(body: string): "urlset" | "sitemapindex" | null {
  if (/<!DOCTYPE|<!ENTITY/i.test(body)) return null;
  const xml = body.replace(/^\uFEFF/, "").replace(/<\?xml[\s\S]*?\?>/gi, "").replace(/<!--[\s\S]*?-->/g, "").trim();
  const root = /^<(urlset|sitemapindex)\b([^>]*)>/i.exec(xml);
  if (!root || !/xmlns\s*=\s*["']http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9["']/i.test(root[2]!)) return null;
  const tag = root[1]!.toLowerCase() as "urlset" | "sitemapindex";
  return new RegExp(`</${tag}\\s*>\\s*$`, "i").test(xml) || /\/\s*$/.test(root[2]!) ? tag : null;
}
const publicProbe = ({ body: _body, ...probe }: ProbeResult) => probe;
export function summarizeCheck(input: Input, probes: ProbeResult[], simulated: boolean) {
  if (probes.length !== limits.requests) throw new Error("Expected the fixed probe package");
  const page = probes[0]!, sitemap = probes[1]!;
  const format = sitemap.outcome === "response" && (sitemap.status ?? 0) >= 200 && (sitemap.status ?? 0) < 300 ? sitemapFormat(sitemap.body) : null;
  const links = probes.slice(2).map(probe => ({ ...publicProbe(probe), state: linkState(probe) }));
  return {
    url: input.url, simulated, requests_planned: limits.requests,
    page: publicProbe(page),
    sitemap: { ...publicProbe(sitemap), format, xml_validation: "not_performed" as const },
    links, broken_links_count: links.filter(l => l.state === "broken").length,
    coverage: "Four fixed probes: page HEAD with TLS verification, GET /sitemap.xml and HEAD of two caller-supplied same-origin links. No redirect following, link discovery, full crawl, full XML validation or fallback GET for HEAD failures. Missing /sitemap.xml does not prove that no sitemap exists elsewhere.",
  };
}
const targets = (i: Input) => [i.url, new URL(i.url).origin + "/sitemap.xml", ...i.link_urls];
function sandboxProbes(i: Input): ProbeResult[] {
  return targets(i).map((url, n) => ({ url, status: 200, outcome: "response", redirect_url: null,
    content_type: n === 1 ? "application/xml" : "text/html", tls: { verified: true, valid_until: "2027-01-01T00:00:00.000Z", protocol: "TLSv1.3" },
    body: n === 1 ? '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>' : "" }));
}

export function createWebsiteCheck(probe: Probe = createPublicProbe()): ServiceDefinition<Input, ReturnType<typeof summarizeCheck>> {
  const example: Input = { url: "https://example.com/", link_urls: ["https://example.com/about", "https://example.com/contact"] };
  return {
    id: cfg.id, name: cfg.name, route: cfg.route, priceUsdc: cfg.priceUsdc, enabled: cfg.enabled,
    cacheTtlSeconds: cfg.cacheTtlSeconds, limits: { maxInputs: cfg.maxInputs, maxResults: cfg.maxResults },
    upstream: { endpoint: cfg.dataforseoEndpoint, maxCostUsd: cfg.maxUpstreamCostUsd },
    summary: "Package: direct HTTPS/TLS and status check for one page, GET /sitemap.xml and HEAD of exactly two supplied same-origin links (four probes per payment). Identifies redirects and 404/410 links. No redirect following or full-site crawl. Sandbox mode returns explicitly simulated checks without network access.",
    notice: "Direct target checks disclose our server IP and requested paths to that website, never buyer IP, wallet or payment details. Target content/headers are untrusted data. Use only public non-confidential URLs. No free sample for this package.",
    inputSchema, estimateCostUsd: () => 0, buildRequest: i => [i],
    mapResult: (task, i) => summarizeCheck(i, arr(obj(arr(task.result)[0]).probes) as ProbeResult[], true),
    async executeRemote(i, mode) {
      if (mode === "sandbox") return summarizeCheck(i, sandboxProbes(i), true);
      const results = await Promise.all(targets(i).map((url, n) => probe(url, n === 1 ? "GET" : "HEAD")));
      return summarizeCheck(i, results, false);
    },
    example, outputExample: summarizeCheck(example, sandboxProbes(example), true),
  };
}
export const websiteCheck = createWebsiteCheck();
