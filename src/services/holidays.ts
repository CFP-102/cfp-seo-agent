import { z } from "zod";
import { addDays } from "./dates.js";
import type { Lang } from "./i18n.js";

/**
 * Public holidays for the planning services: all 16 German states, Austria and Switzerland (federal plus the
 * widely observed days). Pure calculation, no network. Municipal holidays (e.g. Augsburg) and canton-specific Swiss
 * days are not covered; the coverage note says so.
 */
export const HOLIDAY_REGIONS = [
  "none",
  "DE-BW", "DE-BY", "DE-BE", "DE-BB", "DE-HB", "DE-HH", "DE-HE", "DE-MV", "DE-NI", "DE-NW", "DE-RP", "DE-SL", "DE-SN", "DE-ST", "DE-SH", "DE-TH",
  "AT", "CH",
] as const;
export type HolidayRegion = (typeof HOLIDAY_REGIONS)[number];
export const holidayRegionInput = (fallback: HolidayRegion) =>
  z.enum(HOLIDAY_REGIONS).default(fallback);

/** Easter Sunday (Gregorian, anonymous algorithm). */
export function easter(year: number): string {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

type Day = { de: string; en: string };
const H = {
  newYear: { de: "Neujahr", en: "New Year's Day" }, epiphany: { de: "Heilige Drei Könige", en: "Epiphany" },
  womensDay: { de: "Internationaler Frauentag", en: "International Women's Day" }, goodFriday: { de: "Karfreitag", en: "Good Friday" },
  easterMonday: { de: "Ostermontag", en: "Easter Monday" }, labour: { de: "Tag der Arbeit", en: "Labour Day" },
  ascension: { de: "Christi Himmelfahrt", en: "Ascension Day" }, whitMonday: { de: "Pfingstmontag", en: "Whit Monday" },
  corpusChristi: { de: "Fronleichnam", en: "Corpus Christi" }, assumption: { de: "Mariä Himmelfahrt", en: "Assumption Day" },
  childrensDay: { de: "Weltkindertag", en: "World Children's Day" }, unity: { de: "Tag der Deutschen Einheit", en: "German Unity Day" },
  reformation: { de: "Reformationstag", en: "Reformation Day" }, allSaints: { de: "Allerheiligen", en: "All Saints' Day" },
  repentance: { de: "Buß- und Bettag", en: "Day of Repentance and Prayer" }, christmas: { de: "1. Weihnachtstag", en: "Christmas Day" },
  boxing: { de: "2. Weihnachtstag", en: "Boxing Day" }, austria: { de: "Nationalfeiertag", en: "Austrian National Day" },
  immaculate: { de: "Mariä Empfängnis", en: "Immaculate Conception" }, stephen: { de: "Stefanitag", en: "St. Stephen's Day" },
  swiss: { de: "Bundesfeier", en: "Swiss National Day" }, berchtold: { de: "Berchtoldstag", en: "Berchtold's Day" },
} satisfies Record<string, Day>;

const STATES: Record<string, (keyof typeof H)[]> = {
  "DE-BW": ["epiphany", "corpusChristi", "allSaints"],
  "DE-BY": ["epiphany", "corpusChristi", "assumption", "allSaints"], // Mariä Himmelfahrt: in most Bavarian municipalities
  "DE-BE": ["womensDay"],
  "DE-BB": ["reformation"],
  "DE-HB": ["reformation"],
  "DE-HH": ["reformation"],
  "DE-HE": ["corpusChristi"],
  "DE-MV": ["womensDay", "reformation"],
  "DE-NI": ["reformation"],
  "DE-NW": ["corpusChristi", "allSaints"],
  "DE-RP": ["corpusChristi", "allSaints"],
  "DE-SL": ["corpusChristi", "assumption", "allSaints"],
  "DE-SN": ["reformation", "repentance"],
  "DE-ST": ["epiphany", "reformation"],
  "DE-SH": ["reformation"],
  "DE-TH": ["childrensDay", "reformation"],
};

/** Holidays of one region and year: date -> name in the requested language. Empty for "none". */
export function holidays(region: HolidayRegion, year: number, lang: Lang = "de"): Map<string, string> {
  if (region === "none") return new Map();
  const e = easter(year), y = String(year);
  const at = (key: keyof typeof H) => H[key][lang];
  const fixed = (md: string) => `${y}-${md}`;
  const dateOf: Record<keyof typeof H, string> = {
    newYear: fixed("01-01"), epiphany: fixed("01-06"), womensDay: fixed("03-08"), goodFriday: addDays(e, -2), easterMonday: addDays(e, 1),
    labour: fixed("05-01"), ascension: addDays(e, 39), whitMonday: addDays(e, 50), corpusChristi: addDays(e, 60), assumption: fixed("08-15"),
    childrensDay: fixed("09-20"), unity: fixed("10-03"), reformation: fixed("10-31"), allSaints: fixed("11-01"),
    // Buß- und Bettag: the Wednesday before 23 November (between 16 and 22 November)
    repentance: (() => { let d = fixed("11-22"); while (new Date(`${d}T00:00:00Z`).getUTCDay() !== 3) d = addDays(d, -1); return d; })(),
    christmas: fixed("12-25"), boxing: fixed("12-26"), austria: fixed("10-26"), immaculate: fixed("12-08"), stephen: fixed("12-26"),
    swiss: fixed("08-01"), berchtold: fixed("01-02"),
  };
  let keys: (keyof typeof H)[];
  if (region.startsWith("DE-")) keys = ["newYear", "goodFriday", "easterMonday", "labour", "ascension", "whitMonday", "unity", "christmas", "boxing", ...(STATES[region] ?? [])];
  else if (region === "AT") keys = ["newYear", "epiphany", "easterMonday", "labour", "ascension", "whitMonday", "corpusChristi", "assumption", "austria", "allSaints", "immaculate", "christmas", "stephen"];
  else keys = ["newYear", "goodFriday", "easterMonday", "ascension", "whitMonday", "swiss", "christmas", "stephen"]; // CH: widely observed days
  return new Map(keys.map((k) => [dateOf[k], at(k)]));
}

/** All holidays between two dates (inclusive) for a region, as a date -> name map. */
export function holidaysBetween(region: HolidayRegion, from: string, to: string, lang: Lang = "de"): Map<string, string> {
  const out = new Map<string, string>();
  for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)); y++) for (const [d, n] of holidays(region, y, lang)) if (d >= from && d <= to) out.set(d, n);
  return out;
}

export const HOLIDAY_COVERAGE: Record<Lang, string> = {
  de: "Gesetzliche Feiertage der gewählten Region (Bundesland, Österreich oder die in der Schweiz weit verbreiteten Tage); keine kommunalen oder kantonalen Sonderfeiertage, keine Schulferien.",
  en: "Public holidays of the chosen region (German state, Austria, or the widely observed Swiss days); no municipal or cantonal special days, no school holidays.",
};
