import { z } from "zod";
import { PLAN_LIMITS, serviceConfig } from "../config/services.js";
import { recipeDataset } from "./videoRecipes.js";
import { plain } from "./common.js";
import { addDays, isoDate } from "./dates.js";
import { compactExample } from "./exampleCompact.js";
import type { ServiceDefinition } from "./types.js";

/**
 * Shoot-day planner. The time model and bundling rules are ported from the operator's own Content Kalender 2.0
 * (reel 1.5-2 h incl. set-up and extra material, max 3 shoots per day, breaks, lunch, even split over days).
 * Pure rule-based calculation: no network, no AI model, no storage of calendars.
 */
const cfg = serviceConfig("shoot-day-plan");
const shootSchema = z.strictObject({
  title: plain(PLAN_LIMITS.titleChars).describe("Short name of the video, e.g. Product in 30 seconds. Do not put personal data here."),
  recipe_id: z.string().regex(/^tpl-[a-z0-9-]{1,60}$/).optional().describe("Optional recipe id from video-recipes: supplies duration, set-up type, equipment and follow-up formats."),
  media_type: z.enum(["reel", "video", "post", "story", "carousel"]).optional(),
  minutes: z.number().int().min(5).max(240).optional().describe("Pure recording minutes. Default: recipe time or 40."),
  location: plain(PLAN_LIMITS.locationChars).optional().describe("Place label, e.g. Showroom. Same labels are grouped on one day."),
  equipment: z.array(plain(PLAN_LIMITS.equipmentChars)).max(PLAN_LIMITS.equipmentItems).optional(),
});
const inputSchema = z.strictObject({
  shoots: z.array(shootSchema).min(1).max(cfg.maxInputs),
  first_date: isoDate.optional().describe("Optional YYYY-MM-DD of the first shoot day; adds calendar files. Further days follow every second day."),
  start_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default("09:00"),
  max_shoots_per_day: z.number().int().min(1).max(6).default(3),
  max_day_minutes: z.number().int().min(240).max(720).default(480),
  break_minutes: z.number().int().min(0).max(60).default(15),
  lunch_minutes: z.number().int().min(0).max(90).default(45),
});
type Input = z.output<typeof inputSchema>;
export type Shoot = Input["shoots"][number];
/** The scheduling rules shared by the shoot-day planner and the month plan. */
export interface Rules { start_time: string; max_shoots_per_day: number; max_day_minutes: number; break_minutes: number; lunch_minutes: number }

const EXTRA_MIN: Record<string, number> = { foto: 10, karussell: 15, zitat: 5, detailclip: 10, kurzclip: 5, einzeltipp: 5, teaser: 5, story: 5, longform: 0 };
const VARIANT_HINT: Record<string, string> = {
  story: "Zusätzlich: 3–4 kurze Hochformat-Clips für Stories aufnehmen", zitat: "Zusätzlich: ruhiges Porträtfoto für den Zitat-Beitrag",
  foto: "Zusätzlich: 3 Fotos (Übersicht, Detail, Person)", karussell: "Zusätzlich: 5–7 Fotos für ein Karussell",
  detailclip: "Zusätzlich: Detailaufnahmen (Hände, Produkt, Material)", kurzclip: "Antworten jeweils in einem Satz wiederholen lassen (für Kurzclips)",
  einzeltipp: "Jeden Tipp einzeln mit kurzer Pause aufnehmen", teaser: "Zusätzlich: 5-Sekunden-Teaser-Aufnahme", longform: "Komplettes Interview ungeschnitten mitlaufen lassen",
};
type Variant = { type: string; label: string; count: number; mediaType: string };
const DEFAULT_VARIANTS: Record<string, Variant[]> = {
  reel: [{ type: "kurzclip", label: "Kurze Clips", count: 2, mediaType: "reel" }, { type: "foto", label: "Fotos vom Dreh (Bild-Beitrag)", count: 1, mediaType: "post" }, { type: "story", label: "Story-Ausschnitte", count: 2, mediaType: "story" }],
  video: [{ type: "kurzclip", label: "Kurze Antwort-Clips", count: 3, mediaType: "reel" }, { type: "zitat", label: "Zitat-Beitrag (Bild)", count: 1, mediaType: "post" }, { type: "foto", label: "Fotos vom Dreh", count: 1, mediaType: "post" }],
  story: [{ type: "foto", label: "Foto-Beitrag aus dem Dreh", count: 1, mediaType: "post" }],
  post: [{ type: "story", label: "Story mit Verweis", count: 1, mediaType: "story" }],
  carousel: [{ type: "story", label: "Story-Ausschnitte", count: 2, mediaType: "story" }],
};
const SETUP_RANK: Record<string, number> = { interview: 0, screen: 1, detail: 2, mixed: 3, broll: 4 };
const recipeOf = (s: Shoot) => (s.recipe_id ? recipeDataset.recipes.find(r => r.id === s.recipe_id) : undefined);
export const norm = (s: string | undefined) => (s ?? "").toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss").replace(/[^a-z0-9]+/g, " ").trim();
const round15 = (n: number) => Math.round(n / 15) * 15;
export const hhmm = (min: number) => `${String(Math.floor(min / 60) % 24).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
export const toMin = (v: string) => Number(v.slice(0, 2)) * 60 + Number(v.slice(3));

export function block(index: number, s: Shoot) {
  const recipe = recipeOf(s);
  const mediaType = s.media_type ?? recipe?.mediaType ?? "reel";
  const video = mediaType === "reel" || mediaType === "video";
  const core = s.minutes ?? recipe?.shootMinutes ?? 40;
  const variants: Variant[] = recipe?.variants ?? DEFAULT_VARIANTS[mediaType] ?? DEFAULT_VARIANTS.reel!;
  const extras = variants.map(v => ({ type: v.type, label: v.label, count: v.count, minutes: EXTRA_MIN[v.type] ?? 5, hint: VARIANT_HINT[v.type] ?? "" }));
  const extraMinutes = Math.min(30, extras.reduce((a, x) => a + x.minutes, 0));
  const setup = video ? 20 : 10;
  const lo = video ? 90 : 45, hi = video ? 120 : 75;
  const minutes = Math.max(lo, Math.min(hi, round15(setup + core + extraMinutes)));
  const recording = Math.min(core, Math.max(0, minutes - setup - extraMinutes));
  return {
    index, title: s.title, recipe_id: recipe?.id ?? null, media_type: mediaType, location: s.location ?? recipe?.locationHint ?? null,
    setup_type: recipe?.setup ?? "mixed", minutes, setup_minutes: setup, recording_minutes: recording, extra_material_minutes: extraMinutes,
    buffer_minutes: Math.max(0, minutes - setup - recording - extraMinutes), extras,
    equipment: [...(recipe?.equipment ?? []), ...(s.equipment ?? [])], has_questions: (recipe?.questions.length ?? 0) > 0,
  };
}
export type Block = ReturnType<typeof block>;

/** Sort key per block: index of its place by first appearance, so shoots of one place stay together. */
function placeIndex(blocks: Block[]): (b: Block) => number {
  const places: string[] = [];
  for (const b of blocks) { const k = norm(b.location ?? ""); if (!places.includes(k)) places.push(k); }
  return b => places.indexOf(norm(b.location ?? ""));
}
export function groupByPlace(blocks: Block[]): Block[] {
  const at = placeIndex(blocks);
  return blocks.slice().sort((a, b) => at(a) - at(b));
}
export function order(blocks: Block[]): Block[] {
  const at = placeIndex(blocks);
  return blocks.slice().sort((a, b) => at(a) - at(b) || (SETUP_RANK[a.setup_type] ?? 3) - (SETUP_RANK[b.setup_type] ?? 3));
}

export type Row = { start: string; end: string; minutes: number; label: string; kind: "setup" | "pause" | "shoot"; shoot_index: number | null };
export function timeline(blocks: Block[], startMin: number, o: Rules) {
  let t = startMin; const rows: Row[] = []; let lunch = false; let prev: Block | null = null;
  const add = (label: string, minutes: number, kind: Row["kind"], b?: Block) => { rows.push({ start: hhmm(t), end: hhmm(t + minutes), minutes, label, kind, shoot_index: b ? b.index : null }); t += minutes; };
  add("Ankommen, Aufbau & Technik-Check", 30, "setup");
  blocks.forEach((b, i) => {
    if (i > 0 && prev) {
      const moved = norm(prev.location ?? "") !== norm(b.location ?? "");
      if (!lunch && t - startMin >= 210) { add(`Mittagspause${moved ? ` · danach Ortswechsel → ${b.location ?? "anderer Ort"}` : ""}`, o.lunch_minutes, "pause"); lunch = true; }
      else if (moved) add(`Pause & Ortswechsel → ${b.location ?? "anderer Ort"}`, Math.max(20, o.break_minutes), "pause");
      else add(prev.setup_type !== b.setup_type ? "Pause & Kamera umbauen" : "Pause", o.break_minutes, "pause");
    }
    add(b.title, b.minutes, "shoot", b); prev = b;
  });
  add("Abbau & Datensicherung", 20, "setup");
  return { rows, total: t - startMin, end: t };
}

export const fits = (chunk: Block[], o: Rules) => chunk.length <= o.max_shoots_per_day && (chunk.length <= 1 || timeline(order(chunk), toMin(o.start_time), o).total <= o.max_day_minutes);
export function chunks<T>(blocks: T[], n: number): T[][] {
  const base = Math.floor(blocks.length / n), rest = blocks.length % n; const out: T[][] = []; let k = 0;
  for (let i = 0; i < n; i++) { const size = base + (i < rest ? 1 : 0); out.push(blocks.slice(k, k + size)); k += size; }
  return out.filter(c => c.length);
}

export const icsEscape = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
export function icsFold(line: string): string {
  const parts: string[] = []; let cur = "", bytes = 0;
  for (const ch of line) { const b = Buffer.byteLength(ch); if (bytes + b > (parts.length ? 74 : 75)) { parts.push(cur); cur = ""; bytes = 0; } cur += ch; bytes += b; }
  parts.push(cur); return parts.join("\r\n ");
}
function ics(date: string, startMin: number, endMin: number, name: string, location: string | null, description: string): string {
  const stamp = (d: string, m: number) => `${d.replace(/-/g, "")}T${hhmm(m).replace(":", "")}00`;
  const endDate = endMin >= 1440 ? addDays(date, 1) : date;
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Chiemgau Films Agent Data API//Shoot Day Planner//DE", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "BEGIN:VEVENT",
    `UID:shoot-${date}-${startMin}@agent.chiemgaufilms.com`, `DTSTAMP:${date.replace(/-/g, "")}T000000Z`,
    `DTSTART:${stamp(date, startMin)}`, `DTEND:${stamp(endDate, endMin % 1440)}`, `SUMMARY:${icsEscape(name)}`,
    location ? `LOCATION:${icsEscape(location)}` : null, `DESCRIPTION:${icsEscape(description)}`, "END:VEVENT", "END:VCALENDAR",
  ].filter((l): l is string => l !== null).map(icsFold).join("\r\n") + "\r\n";
}

function plan(i: Input) {
  // Same place first (stable), so days are split along places before they are split by count.
  const blocks = groupByPlace(i.shoots.map((s, n) => block(n, s)));
  let days = blocks.length;
  for (let n = 1; n <= blocks.length; n++) { if (chunks(blocks, n).every(c => fits(c, i))) { days = n; break; } }
  const startMin = toMin(i.start_time);
  const warnings: string[] = [];
  const out = chunks(blocks, days).map((chunk, d) => {
    const ordered = order(chunk);
    const tl = timeline(ordered, startMin, i);
    if (tl.total > i.max_day_minutes) warnings.push(`Day ${d + 1} takes ${Math.round(tl.total / 60 * 10) / 10} h, longer than the ${i.max_day_minutes / 60} h limit: a single shoot does not fit. Shorten it or allow a longer day.`);
    const equipment = new Map<string, number>();
    for (const b of ordered) for (const e of b.equipment) { const k = e.trim(); if (k) equipment.set(k, (equipment.get(k) ?? 0) + 1); }
    const mic = ordered.some(b => b.equipment.some(e => /mikro/i.test(e)));
    const checklist = [
      "Drehort reservieren und Zugang klären", "Beteiligte einladen",
      ordered.some(b => b.has_questions) ? "Interviewfragen vorab an die Beteiligten schicken" : null,
      "Einverständnis für Foto/Video der gefilmten Personen klären", "Akkus laden und Speicherplatz frei machen",
      mic ? "Ansteckmikrofon testen" : null, "Drehplan auf dem Handy oder ausgedruckt dabeihaben", "Nach dem Dreh: Material doppelt sichern",
    ].filter((c): c is string => c !== null);
    const date = i.first_date ? addDays(i.first_date, d * 2) : null;
    const locations = [...new Set(ordered.map(b => b.location).filter((l): l is string => !!l))];
    const name = `Videodreh: ${ordered.length} ${ordered.length === 1 ? "Beitrag" : "Beiträge"}${locations.length ? ` · ${locations.join(" / ")}` : ""}`;
    const description = tl.rows.map(r => `${r.start}–${r.end} ${r.label}`).join("\n");
    return {
      day: d + 1, date, start: hhmm(startMin), end: hhmm(tl.end), total_minutes: tl.total,
      shoots: ordered.map(({ has_questions: _questions, ...rest }) => rest),
      schedule: tl.rows,
      extra_content_pieces: ordered.reduce((n, b) => n + b.extras.reduce((a, x) => a + x.count, 0), 0),
      equipment: [...equipment].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
      checklist, calendar_file_ics: date ? ics(date, startMin, tl.end, name, locations[0] ?? null, description) : null,
    };
  });
  return {
    language: "de", rules: { max_shoots_per_day: i.max_shoots_per_day, max_day_minutes: i.max_day_minutes, break_minutes: i.break_minutes, lunch_minutes: i.lunch_minutes, start_time: i.start_time },
    summary: { shoots: blocks.length, shoot_days: out.length, extra_content_pieces: out.reduce((n, d) => n + d.extra_content_pieces, 0) },
    days: out, warnings,
    coverage: "Rule-based planning from the shoots you list. No travel times, no weather, no permits, no availability of people or sites. Day dates, if given, are spaced two days apart. Calendar files are plain .ics text you import yourself; nothing is written to any calendar.",
  };
}

const exampleInput = { shoots: [{ title: "Produkt in 30 Sekunden", recipe_id: "tpl-produkt-in-30-sekunden", location: "Showroom" }, { title: "Mitarbeiter stellt sich vor", recipe_id: "tpl-mitarbeiter-vorstellen", location: "Showroom" }], first_date: "2026-11-10" };
/** The documented example omits defaults (it travels in the 402 header); the output example uses the defaulted form. */
const example: Input = inputSchema.parse(exampleInput);
export const shootDayPlan: ServiceDefinition<Input, ReturnType<typeof plan>> = {
  id: cfg.id, name: cfg.name, route: cfg.route, priceUsdc: cfg.priceUsdc, enabled: cfg.enabled,
  cacheTtlSeconds: cfg.cacheTtlSeconds, limits: { maxInputs: cfg.maxInputs, maxResults: cfg.maxResults },
  upstream: { endpoint: cfg.dataforseoEndpoint, maxCostUsd: cfg.maxUpstreamCostUsd },
  summary: "Turn up to 12 planned videos into realistic shoot days: bundled by place, split evenly (max 3 shoots, 8 h), with set-up, breaks, lunch, timed schedule, equipment list, checklist and optional .ics files.",
  notice: "Rule-based, German labels, no AI model. Do not send names or other personal data: only video titles, place labels and equipment. Results are kept 30 days like all results. Nothing is written to a calendar; calendar files are text you import yourself.",
  inputSchema, estimateCostUsd: () => 0,
  validateInput: i => { const bad = i.shoots.find(s => s.recipe_id && !recipeOf(s)); return bad ? `Unknown recipe_id "${bad.recipe_id}". List valid ids with the video-recipes service.` : null; },
  buildRequest: i => [i], mapResult: (_task, i) => plan(i), executeLocal: plan,
  example: exampleInput as unknown as Input, outputExample: compactExample(plan(example), 1, 50),
};
