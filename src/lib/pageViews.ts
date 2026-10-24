import type { RequestHandler } from "express";
import type { Store } from "./store.js";

/**
 * Privacy-friendly page-view counters: per UTC day only a number per page group and visitor type (browser or bot).
 * No IP address, no cookie, no user agent and no referrer is stored; the user agent is only used for the bot guess.
 * Views are buffered in memory and written in one small transaction every few seconds, so a flood of page requests
 * never turns into one database write per request.
 */
export const SITE_COUNTER = "site";

const GROUPS: [string, string[]][] = [
  ["home", ["/", "/index.html", "/de", "/de/", "/index-de.html"]],
  ["agencies", ["/agencies", "/agentur-en.html", "/de/agenturen", "/agenturen", "/agentur-de.html"]],
  ["status", ["/status", "/status.html", "/de/status", "/de/status.html"]],
  ["docs", ["/legal.html", "/legal-de.html", "/quickstart.html", "/llms.txt", "/openapi.json"]],
  ["agent_files", ["/.well-known/agent.json", "/agent.json", "/.well-known/mcp/server-card.json", "/.well-known/mcp.json", "/.well-known/x402"]],
];
const GROUP_OF = new Map(GROUPS.flatMap(([g, paths]) => paths.map((p) => [p, g] as const)));
export const PAGE_GROUPS = GROUPS.map(([g]) => g);

/** Known automated clients only (crawlers, HTTP libraries, monitors, AI fetchers); ordinary browsers stay "human". */
const BOT = /bot\b|bot\/|crawler|spider|slurp|curl\/|wget\/|python-|python\/|node-fetch|undici|axios\/|go-http-client|java\/|okhttp|apache-httpclient|scrapy|uptimerobot|monitor|facebookexternalhit|headlesschrome|lighthouse|postmanruntime|insomnia|gptbot|claudebot|claude-web|anthropic-ai|perplexitybot|bytespider|ahrefs|semrush|x402|mcp-/i;
/** No user agent, a non-browser user agent, or a known bot token counts as a bot. */
export const looksLikeBot = (ua: string | undefined) => !ua || !/mozilla\/5\.0/i.test(ua) || BOT.test(ua);

export const pageGroup = (path: string) => GROUP_OF.get(path) ?? null;
export const viewKind = (group: string, bot: boolean) => `view_${group}_${bot ? "bot" : "human"}`;
const MAX_KEYS = 64; // groups x 2 x a day change: the buffer can never grow without bound

export function createPageViewCounter(store: Store, opts: { flushMs?: number; now?: () => Date } = {}) {
  const clock = opts.now ?? (() => new Date());
  let buffer = new Map<string, number>(); // "day|kind" -> count

  const flush = () => {
    if (!buffer.size) return;
    const pending = buffer;
    buffer = new Map();
    const byDay = new Map<string, { serviceId: string; kind: string; n: number }[]>();
    for (const [key, n] of pending) {
      const [day, kind] = key.split("|") as [string, string];
      byDay.set(day, [...(byDay.get(day) ?? []), { serviceId: SITE_COUNTER, kind, n }]);
    }
    try {
      for (const [day, items] of byDay) store.bumpMany(day, items);
    } catch {
      /* counting must never break the service; a lost batch only lowers a statistic */
    }
  };

  const middleware: RequestHandler = (req, res, next) => {
    const group = req.method === "GET" ? pageGroup(req.path) : null;
    if (group) {
      const bot = looksLikeBot(req.get("user-agent"));
      res.on("finish", () => {
        // 304 = a returning visitor revalidated the cached page: still a view.
        if (res.statusCode !== 200 && res.statusCode !== 304) return;
        const key = `${clock().toISOString().slice(0, 10)}|${viewKind(group, bot)}`;
        if (!buffer.has(key) && buffer.size >= MAX_KEYS) flush();
        buffer.set(key, (buffer.get(key) ?? 0) + 1);
      });
    }
    next();
  };

  const timer = setInterval(flush, opts.flushMs ?? 15_000);
  timer.unref();
  return { middleware, flush, stop: () => { clearInterval(timer); flush(); } };
}
export type PageViewCounter = ReturnType<typeof createPageViewCounter>;
