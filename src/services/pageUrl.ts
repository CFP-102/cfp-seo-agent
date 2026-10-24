import { z } from "zod";
import { domainString } from "./common.js";

/** One public http(s) page: no credentials, no IP address, no port; the host must be a normal domain name. */
export const pageUrl = z
  .string()
  .trim()
  .max(2000)
  .transform((s, ctx) => {
    let u: URL;
    try {
      u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    } catch {
      ctx.addIssue({ code: "custom", message: "url must be a valid http(s) URL such as https://example.com/page" });
      return z.NEVER;
    }
    if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || u.port) {
      ctx.addIssue({ code: "custom", message: "url must be a plain http(s) URL without credentials or port" });
      return z.NEVER;
    }
    const host = domainString.safeParse(u.hostname);
    if (!host.success || /(?:^|\.)(?:localhost|local|internal|invalid|test|onion|arpa)$/i.test(u.hostname)) {
      ctx.addIssue({ code: "custom", message: "url host must be a domain name (IP addresses and internal hosts are rejected)" });
      return z.NEVER;
    }
    u.hash = "";
    return u.toString();
  })
  .describe("Public page URL to audit, e.g. https://example.com/pricing. IP addresses, ports and credentials are rejected.");

