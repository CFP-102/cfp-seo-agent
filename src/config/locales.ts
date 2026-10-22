import data from "./locales.json" with { type: "json" };

/**
 * Supported location/language combinations per DataForSEO API family, from the committed snapshot
 * src/config/locales.json (refresh: `npx tsx --env-file=.env scripts/update-locales.ts`).
 * Used to refuse unsupported combinations BEFORE a payment is requested.
 *
 * Locations are country-level DataForSEO codes (e.g. 2840 United States, 2276 Germany, 2826 United Kingdom).
 */
export type LocaleFamily = "google_ads" | "serp" | "labs" | "ai" | "bing" | "trends";

const countries = new Set<number>(data.countries);
const adsLanguages = new Set<string>(data.google_ads_languages);
const serpLanguages = new Set<string>(data.serp_languages);
const bingCountries = new Set<number>(data.bing_countries);
const bingLanguages = new Set<string>(data.bing_languages);
const trendsCountries = new Set<number>(data.trends_countries);
const trendsLanguages = new Set<string>(data.trends_languages);
const labsPairs = data.labs as Record<string, string[]>;
const aiPairs = data.ai as Record<string, string[]>;

/** Default language for a location when the caller gives none: English if offered, else the first listed. */
export function defaultLanguage(location: number): string {
  const langs = labsPairs[String(location)] ?? [];
  return langs.includes("en") ? "en" : (langs[0] ?? "en");
}

export function checkLocale(family: LocaleFamily, location: number, language: string): string | null {
  const unknownLocation = `location_code ${location} is not supported. Use a country-level code, e.g. 2840 (United States), 2276 (Germany), 2826 (United Kingdom).`;
  if (family === "labs" || family === "ai") {
    const pairs = family === "labs" ? labsPairs : aiPairs;
    const langs = pairs[String(location)];
    if (!langs) return unknownLocation;
    if (!langs.includes(language)) return `language_code "${language}" is not available for location_code ${location} on this service. Available: ${langs.join(", ")}.`;
    return null;
  }
  if (family === "bing" || family === "trends") {
    const [cs, ls] = family === "bing" ? [bingCountries, bingLanguages] : [trendsCountries, trendsLanguages];
    if (!cs.has(location)) return unknownLocation;
    return ls.has(language) ? null : `language_code "${language}" is not supported by this service.`;
  }
  if (!countries.has(location)) return unknownLocation;
  const known = family === "google_ads" ? adsLanguages : serpLanguages;
  if (!known.has(language)) return `language_code "${language}" is not supported by this service.`;
  return null;
}

export const LOCALES_GENERATED_AT: string = data.generated_at;
