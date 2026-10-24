import { z } from "zod";

/** Calendar dates as plain YYYY-MM-DD strings, computed in UTC so results never depend on the server time zone. */
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => { const d = new Date(`${v}T00:00:00Z`); return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v); }, "Not a real calendar date")
  .refine(v => v >= "2020-01-01" && v <= "2100-12-31", "Date out of range (2020-2100)");
const ms = (date: string) => Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10));
export const addDays = (date: string, n: number) => new Date(ms(date) + n * 86400000).toISOString().slice(0, 10);
/** b minus a in days. */
export const diffDays = (a: string, b: string) => Math.round((ms(b) - ms(a)) / 86400000);
/** 0 = Monday ... 6 = Sunday. */
export const weekday = (date: string) => (new Date(ms(date)).getUTCDay() + 6) % 7;
export const isWeekend = (date: string) => weekday(date) >= 5;
export const berlinToday = (now: Date = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
export const WEEKDAY_NAMES = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

/** Easter Sunday (Gregorian, anonymous algorithm). */
function easter(year: number): string {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
/** Public holidays in Bavaria (Mariä Himmelfahrt included: it applies in most Bavarian municipalities), name by date. */
export function bavarianHolidays(year: number): Map<string, string> {
  const e = easter(year), y = String(year);
  return new Map([
    [`${y}-01-01`, "Neujahr"], [`${y}-01-06`, "Heilige Drei Könige"], [addDays(e, -2), "Karfreitag"], [addDays(e, 1), "Ostermontag"],
    [`${y}-05-01`, "Tag der Arbeit"], [addDays(e, 39), "Christi Himmelfahrt"], [addDays(e, 50), "Pfingstmontag"], [addDays(e, 60), "Fronleichnam"],
    [`${y}-08-15`, "Mariä Himmelfahrt"], [`${y}-10-03`, "Tag der Deutschen Einheit"], [`${y}-11-01`, "Allerheiligen"],
    [`${y}-12-25`, "1. Weihnachtstag"], [`${y}-12-26`, "2. Weihnachtstag"],
  ]);
}
