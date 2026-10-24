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
