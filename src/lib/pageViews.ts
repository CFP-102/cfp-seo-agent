import type { RequestHandler } from "express";
import type { Store } from "./store.js";

/**
 * Privacy-friendly page-view counters: per UTC day only a number per page group and visitor type (browser or bot).
 * No IP address, no cookie, no user agent and no referrer is stored; the user agent is only used for the bot guess.
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

const BOT = /bot|crawl|spider|slurp|fetch|curl|wget|python|node|axios|go-http|java|okhttp|httpclient|scrapy|monitor|uptime|preview|facebookexternalhit|headless|lighthouse|postman|insomnia|x402|mcp|glama|claude|gpt|anthropic|openai/i;
/** Browsers send a Mozilla/5.0 user agent; anything else, or a known bot word, counts as a bot. */
export const looksLikeBot = (ua: string | undefined) => !ua || !/mozilla\/5\.0/i.test(ua) || BOT.test(ua);

export const pageGroup = (path: string) => GROUP_OF.get(path) ?? null;
export const viewKind = (group: string, bot: boolean) => `view_${group}_${bot ? "bot" : "human"}`;

export function countPageViews(store: Store): RequestHandler {
  return (req, res, next) => {
    const group = req.method === "GET" ? pageGroup(req.path) : null;
    if (group) {
      const bot = looksLikeBot(req.get("user-agent"));
      res.on("finish", () => {
        if (res.statusCode === 200) {
          try { store.bump(SITE_COUNTER, viewKind(group, bot)); } catch { /* counting must never break a page */ }
        }
      });
    }
    next();
  };
}
