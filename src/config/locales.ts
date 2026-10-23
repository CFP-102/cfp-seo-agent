import data from "./locales.json" with { type: "json" };
import dach from "./locations-dach.json" with { type: "json" };

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

/** City/region-level Google locations in Germany, Austria and Switzerland (Google SERP family only: organic, Maps, News, Images). */
const DACH_COUNTRY: Record<string, number> = { DE: 2276, AT: 2040, CH: 2756 };
export interface DachLocation { location_code: number; name: string; type: string; country_iso_code: string; country_code: number }
const dachLocations: DachLocation[] = (dach.rows as [number, string, string, string][]).map(([code, name, type, cc]) => ({
  location_code: code,
  name,
  type,
  country_iso_code: cc,
  country_code: DACH_COUNTRY[cc]!,
}));
const dachByCode = new Map(dachLocations.map((l) => [l.location_code, l]));
// Folded names computed once (search runs on every lookup request).
export const isDachLocation = (code: number) => dachByCode.has(code);
export const dachLocationName = (code: number) => dachByCode.get(code)?.name;

/** Lowercase, umlauts folded (ü -> u, ß -> ss) so "Zürich" finds "Zurich". */
const fold = (s: string) => s.toLowerCase().replace(/ß/g, "ss").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const foldedNames = new Map(dachLocations.map((l) => [l.location_code, fold(l.name)]));
/** DataForSEO names many DACH places in English; map common German names (after fold) to the stored name. */
const GERMAN_NAMES: Record<string, string> = {
  munchen: "munich", koln: "cologne", wien: "vienna", nurnberg: "nuremberg", hannover: "hanover", genf: "geneva", bayern: "bavaria",
  luzern: "lucerne", tirol: "tyrol", karnten: "carinthia", steiermark: "styria", niederosterreich: "lower austria", oberosterreich: "upper austria",
  niedersachsen: "lower saxony", "nordrhein-westfalen": "north rhine-westphalia", hessen: "hesse", sachsen: "saxony", thuringen: "thuringia",
  "rheinland-pfalz": "rhineland-palatinate", "sachsen-anhalt": "saxony-anhalt", "mecklenburg-vorpommern": "mecklenburg-vorpommern",
  bern: "bern", basel: "basel", zurich: "zurich", "sankt gallen": "st. gallen", "st. gallen": "st. gallen", tessin: "ticino", wallis: "valais", graubunden: "grisons",
};

/** Free location search for the SERP family: case-insensitive match on the location name (umlauts and German names understood), cities first. */
export function searchDachLocations(query: string, country?: string, limit = 20): DachLocation[] {
  const folded = fold(query.trim());
  const q = Object.hasOwn(GERMAN_NAMES, folded) ? GERMAN_NAMES[folded]! : folded;
  const cc = country?.toUpperCase();
  const rank: Record<string, number> = { City: 0, Municipality: 1, District: 2, State: 3, Canton: 3, Region: 3 };
  return dachLocations
    .filter((l) => (!cc || l.country_iso_code === cc) && foldedNames.get(l.location_code)!.includes(q))
    .map((l) => ({ l, head: foldedNames.get(l.location_code)!.startsWith(q) ? 0 : 1 }))
    .sort((a, b) => a.head - b.head || (rank[a.l.type] ?? 9) - (rank[b.l.type] ?? 9) || a.l.name.length - b.l.name.length)
    .slice(0, limit)
    .map((x) => x.l);
}

/** Default language for a location when the caller gives none: English if offered, else the first listed. */
export function defaultLanguage(location: number): string {
  const city = dachByCode.get(location);
  if (city) return defaultLanguage(city.country_code);
  const langs = labsPairs[String(location)] ?? [];
  return langs.includes("en") ? "en" : (langs[0] ?? "en");
}

export function checkLocale(family: LocaleFamily, location: number, language: string): string | null {
  const city = dachByCode.get(location);
  if (city && family !== "serp") {
    return `location_code ${location} (${city.name}) is a city/region code: this service accepts country-level codes only, e.g. ${city.country_code} for ${city.country_iso_code}. City codes work for the Google SERP, Maps, News, Images and Local Market Check services.`;
  }
  if (city) return serpLanguages.has(language) ? null : `language_code "${language}" is not supported by this service.`;
  const unknownLocation = `location_code ${location} is not supported. Use a country-level code, e.g. 2840 (United States), 2276 (Germany), 2826 (United Kingdom); for Google SERP, Maps, News, Images and Local Market Check also a city/region code in Germany, Austria or Switzerland (free lookup: GET /api/v1/locations?q=rosenheim).`;
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
