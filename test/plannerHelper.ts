import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

export type Planner = Record<string, any>;
/** Load agentur.js + planner.js + project.js in a sandbox without a page: only the pure helpers are exposed. */
export function loadPlanner(lang: "de" | "en" = "de"): { planner: Planner; pay: Planner; project: Planner } {
  const window: Record<string, any> = {};
  const document = { documentElement: { lang }, getElementById: () => null };
  const ctx = { window, document, TextEncoder, TextDecoder, btoa, atob, URL, console };
  runInNewContext(readFileSync(new URL("../public/agentur.js", import.meta.url), "utf8"), ctx);
  runInNewContext(readFileSync(new URL("../public/planner.js", import.meta.url), "utf8"), ctx);
  runInNewContext(readFileSync(new URL("../public/project.js", import.meta.url), "utf8"), ctx);
  return { planner: window.CfpPlanner, pay: window.AgenturPay, project: window.CfpProject };
}

