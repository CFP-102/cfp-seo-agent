import { z } from "zod";
import { checkLocale, defaultLanguage, type LocaleFamily } from "../config/locales.js";
import { DataForSeoError } from "../dataforseo/client.js";

/**
 * Shared input building blocks. Inputs are strict (unknown fields rejected),
 * normalized (trimmed, lowercased) and restricted to a conservative character
 * set so nothing unexpected is forwarded to DataForSEO.
 */

// Rejects control characters and symbols DataForSEO refuses or treats as operators.
const FORBIDDEN_KEYWORD_CHARS = /[\u0000-\u001f\u007f<>{}\[\]|\\^~`!@%*=;?,]/u;

export const keywordString = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, "keyword must not be empty")
  .max(80, "keyword must be at most 80 characters")
  .refine((k) => !FORBIDDEN_KEYWORD_CHARS.test(k), "keyword contains unsupported characters")
  .refine((k) => k.split(/\s+/).length <= 10, "keyword must have at most 10 words");

export function keywordList(max: number) {
  return z
    .array(keywordString)
    .min(1, "at least one keyword is required")
    .max(max, `at most ${max} keywords per request`)
    .transform((list) => [...new Set(list)])
    .describe(`Keywords to look up: 1 to ${max} entries, each up to 80 characters / 10 words. Lowercased, duplicates removed.`);
}

/** SERP keyword: no search operators (site:, intitle:, quotes, -exclusions), which DataForSEO bills at 5x. */
export const serpKeyword = keywordString
  .refine((k) => !/[":]/.test(k), "search operators (quotes, site:, intitle:, ...) are not supported")
  .refine((k) => !/(^|\s)-\S/.test(k), "search operators (-exclusions) are not supported")
  .describe("The search query (up to 80 characters). Search operators such as site:, intitle:, quotes or -exclusions are not supported.");

const DOMAIN_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

/** Domain such as example.com. Accepts a pasted URL (scheme, www, path are stripped); rejects IPs, hosts without TLD, ports. */
export const domainString = z
  .string()
  .trim()
  .toLowerCase()
  .max(300)
  .transform((s) => s.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[/?#].*$/, "").replace(/\.$/, ""))
  .refine((s) => DOMAIN_RE.test(s), "domain must be a valid domain name such as example.com (no IP addresses or ports)")
  .describe("Domain to analyze, e.g. example.com. A pasted URL is reduced to its domain; IP addresses and ports are rejected.");

/** DataForSEO numeric country-level location code, e.g. 2840 (United States), 2276 (Germany). */
export const locationCode = z
  .number()
  .int()
  .min(1000)
  .max(99_999_999)
  .default(2840)
  .describe("DataForSEO location code. Country level: 2840 = United States (default), 2276 = Germany, 2040 = Austria, 2756 = Switzerland. Google SERP, Maps, News, Images and Local Market Check also accept city/region codes in Germany, Austria and Switzerland (free lookup: GET /api/v1/locations?q=...).");

/** DataForSEO language code, e.g. "en", "de", "zh-TW". If omitted, a default for the location is chosen. */
const languageCodeOptional = z
  .string()
  .trim()
  .regex(/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/, "language_code must look like 'en' or 'zh-TW'")
  .optional()
  .describe("Language code such as en or de. Default: English if available for the country, else its first language. Unsupported country/language pairs are refused before payment.");

/** Strict object with location_code (default 2840) and language_code (default depends on the location). */
export function withLocale<S extends z.ZodRawShape>(shape: S) {
  const schema = z.strictObject({ ...shape, location_code: locationCode, language_code: languageCodeOptional });
  type Out = Omit<z.output<typeof schema>, "language_code"> & { language_code: string };
  return schema.transform((v): Out => {
    const { location_code, language_code } = v as unknown as { location_code: number; language_code?: string };
    return { ...v, language_code: language_code ?? defaultLanguage(location_code) } as unknown as Out;
  });
}

/** Pre-payment check that DataForSEO supports this location/language combination for the service's API family. */
export function localeValidator(family: LocaleFamily) {
  return (input: { location_code: number; language_code: string }) => checkLocale(family, input.location_code, input.language_code);
}

/** Inputs DataForSEO returned nothing for (not charged by DataForSEO). Lets callers see what was not covered. */
export function missingKeywords(requested: string[], returned: string[]): string[] {
  const got = new Set(returned.map((k) => k.toLowerCase()));
  return requested.filter((k) => !got.has(k));
}

export const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
export const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
export const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export const round2 = (v: number | null): number | null => (v === null ? null : Math.round(v * 100) / 100);

/** Machine-readable input schema (JSON Schema 2020-12) for OpenAPI, MCP and Bazaar. */
export function inputJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const js = z.toJSONSchema(schema, { io: "input", unrepresentable: "any", target: "draft-2020-12" }) as Record<string, unknown>;
  delete js.$schema;
  return js;
}

/** Schema keywords whose values are data (not sub-schemas): never rewritten. */
const DATA_KEYWORDS = new Set(["default", "const", "enum", "examples", "example"]);
const ISO_DATE_PATTERN = "^\\d{4}-\\d{2}-\\d{2}$";

/**
 * Compact copy of an input schema for the x402 `payment-required` header (Bazaar discovery): the header must stay well below the
 * 8 KB per-line limit of some HTTP clients (Python aiohttp 8190). Keeps names, types, enums and bounds; drops prose descriptions and
 * string patterns (the full schema stays in OpenAPI, MCP and llms.txt, and the server validates every input anyway). Calendar-date
 * patterns become `format: "date"` so agents still see the shape.
 */
export function discoverySchema(schema: Record<string, unknown>): Record<string, unknown> {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== "object") return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (DATA_KEYWORDS.has(k)) out[k] = x;
      else if (k === "description" && typeof x === "string") continue;
      else if (k === "pattern" && typeof x === "string") { if (x === ISO_DATE_PATTERN) out.format = "date"; }
      else out[k] = walk(x);
    }
    return out;
  };
  return walk(schema) as Record<string, unknown>;
}

/** MCP tool name for a service id: keyword-metrics -> keyword_metrics. */
export const toolNameOf = (serviceId: string) => serviceId.replace(/-/g, "_");

/**
 * Trimmed, 1..max characters, no control characters (free-text labels of the planning services).
 * Written with \xNN escapes: the pattern is published in JSON Schema, and Coinbase Bazaar (Go RE2) rejects \uNNNN.
 */
export const plain = (max: number) => z.string().trim().min(1).max(max).regex(/^[^\x00-\x1f\x7f]+$/u, "Control characters are not allowed");

/** Reads a response body up to `maxBytes`; larger or unreadable bodies are refused with a bad_response error. */
export async function readBounded(response: Response, maxBytes: number): Promise<Buffer> {
  const reader = response.body!.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) { await reader.cancel(); throw new DataForSeoError("Source response too large", "bad_response"); }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } catch (error) {
    if (error instanceof DataForSeoError) throw error;
    throw new DataForSeoError("Unreadable source response", "bad_response");
  } finally { reader.releaseLock(); }
}
