import { createHash } from "node:crypto";
import { z } from "zod";
import { PLAN_LIMITS, serviceConfig } from "../config/services.js";
import { plain } from "./common.js";
import { addDays, bavarianHolidays, berlinToday, diffDays, isWeekend, isoDate } from "./dates.js";
import { compactExample } from "./exampleCompact.js";
import { hhmm, icsEscape, icsFold, norm, toMin } from "./shootPlan.js";
import { sunTimes } from "./sunTimes.js";
import { matchTrade, type Trade } from "./trades.js";
import { recipeDataset } from "./videoRecipes.js";
import type { ServiceDefinition } from "./types.js";

/**
 * Video project planner for one concrete customer job, e.g. "recruiting reels for a metal workshop in Chieming, one shoot
 * day 08:00-17:00 on 2026-11-20, delivery by 2026-12-23". Combines, in one call: reel ideas fitted to goal, trade and town
 * (or the customer's own list), a single shoot day that respects the given time window (as many reels as fit, the rest as
 * reserve), a call sheet by role, sun times for outdoor shots, and the post-production timeline up to the delivery date with
 * Bavarian holidays. Rule-based, no AI model, stateless, no network.
 */
const cfg = serviceConfig("video-project-plan");
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const GOALS = ["recruiting", "produkt", "unternehmen"] as const;
type Goal = (typeof GOALS)[number];
const SETUPS = ["interview", "screen", "detail", "mixed", "broll"] as const;

const reelSchema = z.strictObject({
  title: plain(PLAN_LIMITS.titleChars).describe("Own idea, no names."),
  recipe_id: z.string().regex(/^tpl-[a-z0-9-]{1,60}$/).optional(),
  recording_minutes: z.number().int().min(5).max(120).optional(),
  location: plain(PLAN_LIMITS.locationChars).optional(),
  outdoor: z.boolean().optional(),
  people: plain(PLAN_LIMITS.titleChars).optional().describe("Roles only, no names."),
});
const inputSchema = z.strictObject({
  goal: z.enum(GOALS),
  industry: plain(60).optional().describe("e.g. Metallbau"),
  town: plain(60).optional().describe("Company town, e.g. Chieming"),
  job_titles: z.array(plain(60)).max(3).optional(),
  shoot_date: isoDate,
  day_start: clock.default("08:00"),
  day_end: clock.default("17:00"),
  deliver_by: isoDate,
  reel_count_min: z.number().int().min(1).max(PLAN_LIMITS.shoots).default(5),
  reel_count_max: z.number().int().min(1).max(PLAN_LIMITS.shoots).optional(),
  reels: z.array(reelSchema).max(PLAN_LIMITS.shoots).optional().describe("Own ideas, planned first"),
  locations: z.array(plain(PLAN_LIMITS.locationChars)).min(1).max(6).optional(),
  latitude: z.number().min(47.2).max(55.1).optional().describe("Optional: sun times"),
  longitude: z.number().min(5.8).max(15.1).optional(),
  lunch_minutes: z.number().int().min(0).max(90).default(45),
  review_rounds: z.number().int().min(0).max(3).default(2),
  client_feedback_days: z.number().int().min(1).max(10).default(3),
  edit_reels_per_day: z.number().int().min(1).max(8).default(3),
  today: isoDate.optional(),
}).refine(d => (d.latitude === undefined) === (d.longitude === undefined), { message: "Send latitude and longitude together", path: ["longitude"] })
  .refine(d => d.reel_count_max === undefined || d.reel_count_max >= d.reel_count_min, { message: "reel_count_max must not be below reel_count_min", path: ["reel_count_max"] });
type Input = z.output<typeof inputSchema>;

/* ---------- ideas ---------- */
interface Ctx { job: string; apprenticeship: string; areas: string[]; activity: string; product: string; tool: string; town: string | null; label: string; outdoorWork: string | null }
interface IdeaTpl { recipe: string; title: (c: Ctx) => string; hook: (c: Ctx) => string; area: number; outdoor?: boolean; place?: (c: Ctx) => string; needs?: (c: Ctx) => boolean }
const inTown = (c: Ctx, word = "in") => (c.town ? ` ${word} ${c.town}` : "");
export const IDEAS: Record<Goal, IdeaTpl[]> = {
  recruiting: [
    { recipe: "tpl-azubi-interview", area: 0, title: c => `Azubi erzählt: Warum ${c.job}?`, hook: c => `Warum ich ${c.job} geworden bin – ganz ehrlich.` },
    { recipe: "tpl-neuer-arbeitsplatz", area: 0, title: c => `Dein Arbeitsplatz: unsere ${c.areas[0]}${inTown(c)}`, hook: () => "Hier könnte ab nächstem Monat dein Arbeitsplatz sein." },
    { recipe: "tpl-ausbildungsberuf-vorstellen", area: 0, title: c => `Das lernst du in der ${c.apprenticeship}`, hook: c => `Nach der Schule keinen Plan? ${c.job} ist mehr, als du denkst.` },
    { recipe: "tpl-maschine-in-aktion", area: 1, title: c => `${c.activity} – so sieht das in echt aus`, hook: c => `Hättest du gedacht, dass ${c.activity} so aussieht?` },
    { recipe: "tpl-teamvorstellung", area: 0, title: c => `Das Team${inTown(c, "aus")} stellt sich vor`, hook: () => "Das sind die Leute, mit denen du jeden Tag arbeitest." },
    { recipe: "tpl-mythos-vs-realitaet", area: 0, title: c => `Mythos vs. Realität: ${c.job}`, hook: c => `„${c.job}? Das ist doch nur …“ – stimmt so nicht.` },
    { recipe: "tpl-blick-hinter-die-kulissen", area: 1, title: c => `Vom Rohmaterial zum fertigen ${c.product}`, hook: c => `Vom Rohmaterial zum fertigen ${c.product} – in 30 Sekunden.` },
    { recipe: "tpl-3-tipps-vom-experten", area: 2, title: c => `3 Gründe, bei uns ${c.job} zu werden`, hook: () => "Drei Gründe, warum du bei uns anfangen solltest." },
    { recipe: "tpl-werkzeug-erklaert", area: 1, title: c => `Ohne ${c.tool} geht nichts`, hook: c => `Das ist unser wichtigstes Werkzeug: ${c.tool}.` },
    { recipe: "tpl-blick-hinter-die-kulissen", area: -1, outdoor: true, needs: c => c.outdoorWork !== null, title: c => `Unterwegs: ${c.outdoorWork}`, hook: () => "Nicht nur in der Halle: so sieht ein Einsatz draußen aus." },
    { recipe: "tpl-bewerbung-in-60-sekunden", area: 2, title: () => "Bewerben in 60 Sekunden – so einfach geht's", hook: () => "Bewerben bei uns? Dauert keine 5 Minuten." },
    { recipe: "tpl-ausbilder-stellt-sich-vor", area: 0, title: () => "Dein Ausbilder stellt sich vor", hook: () => "Ich bin der, der dir hier alles beibringt." },
    { recipe: "tpl-pov-job", area: 1, title: c => `POV: Dein erster Tag als ${c.job}`, hook: () => "POV: Du bist ab heute bei uns." },
    { recipe: "tpl-klartext-arbeitszeit", area: 2, title: () => "Klartext: Arbeitszeit, Urlaub, Gehalt", hook: () => "Die Fragen, die sich keiner traut – hier die Antworten." },
    { recipe: "tpl-erster-arbeitstag", area: 0, title: () => "Dein erster Arbeitstag bei uns", hook: () => "Das passiert an deinem ersten Tag bei uns." },
    { recipe: "tpl-azubi-pruefungsstueck", area: 0, title: () => "Prüfungsstück: Das hat unser Azubi gebaut", hook: () => "Das hat unser Azubi ganz allein gebaut." },
    { recipe: "tpl-quereinsteiger", area: 0, title: c => `Quereinstieg als ${c.job}`, hook: () => "Früher war ich ganz woanders. Heute bin ich hier." },
    { recipe: "tpl-benefits-gezeigt", area: 0, title: () => "Benefits, die man sehen kann", hook: () => "Was es bei uns gibt – nicht nur auf dem Papier." },
    { recipe: "tpl-neuer-mitarbeiter", area: 2, title: () => "Erste Woche im Team", hook: () => "Meine erste Woche hier – das hätte ich nicht erwartet." },
    { recipe: "tpl-ein-tag-im-unternehmen", area: 0, title: c => `Ein Tag als ${c.job}${inTown(c)}`, hook: c => `Ein ganz normaler Tag als ${c.job}.` },
  ],
  produkt: [
    { recipe: "tpl-produkt-in-30-sekunden", area: 0, title: c => `Unser ${c.product} in 30 Sekunden`, hook: c => `Was macht ein gutes ${c.product} aus? 30 Sekunden.` },
    { recipe: "tpl-schritt-fuer-schritt", area: 1, title: c => `Schritt für Schritt: so entsteht ein ${c.product}`, hook: () => "Vom ersten Schritt bis zum fertigen Ergebnis." },
    { recipe: "tpl-produktdetail", area: 0, title: () => "Details, die man nur aus der Nähe sieht", hook: () => "Auf diese Details achten die wenigsten." },
    { recipe: "tpl-maschine-in-aktion", area: 1, title: c => `${c.activity} in Aktion`, hook: () => "Hättest du gedacht, dass das so schnell geht?" },
    { recipe: "tpl-werkzeug-erklaert", area: 1, title: c => `Ohne ${c.tool} geht nichts`, hook: c => `Das ist unser wichtigstes Werkzeug: ${c.tool}.` },
    { recipe: "tpl-fehler-die-kunden-machen", area: 0, title: c => `3 Fehler beim Kauf von ${c.product}`, hook: () => "Diese Fehler sehen wir immer wieder." },
    { recipe: "tpl-kundenfragen", area: 2, title: () => "Die häufigste Kundenfrage – beantwortet", hook: () => "Diese Frage hören wir jede Woche." },
    { recipe: "tpl-a-oder-b", area: 0, title: () => "A oder B? Der ehrliche Vergleich", hook: () => "A oder B? Kommt drauf an – und zwar darauf." },
    { recipe: "tpl-auftrag-ablauf", area: 2, title: () => "So läuft ein Auftrag bei uns ab", hook: () => "Von der Anfrage bis zur Übergabe – so läuft es." },
    { recipe: "tpl-pflegetipp", area: 1, title: c => `Pflege-Tipp: So hält dein ${c.product} länger`, hook: () => "Mit diesem Trick hält es doppelt so lange." },
    { recipe: "tpl-vorher-nachher", area: -1, outdoor: true, needs: c => c.outdoorWork !== null, title: () => "Vorher / Nachher beim Kunden", hook: () => "Vorher – nachher. Muss man mehr sagen?" },
  ],
  unternehmen: [
    { recipe: "tpl-unternehmensgeschichte", area: 2, title: c => `Wie alles anfing: ${c.label}${inTown(c, "aus")}`, hook: () => "So hat bei uns alles angefangen." },
    { recipe: "tpl-teamvorstellung", area: 0, title: c => `Das Team${inTown(c, "aus")} stellt sich vor`, hook: () => "Das sind die Menschen hinter unserer Arbeit." },
    { recipe: "tpl-zahlen-und-fakten", area: 0, title: () => "Unser Betrieb in Zahlen", hook: () => "Ein paar Zahlen, die uns selbst überrascht haben." },
    { recipe: "tpl-blick-hinter-die-kulissen", area: 1, title: () => "Blick hinter die Kulissen", hook: () => "Das sehen unsere Kunden normalerweise nie." },
    { recipe: "tpl-mitarbeiter-vorstellen", area: 0, title: () => "Wer steckt eigentlich dahinter?", hook: () => "Ohne diese Person läuft hier nichts." },
    { recipe: "tpl-chef-antwortet", area: 2, title: () => "Der Chef antwortet", hook: () => "Ihr habt gefragt – der Chef antwortet." },
    { recipe: "tpl-werte-im-alltag", area: 0, title: () => "Unsere Werte – im Alltag gezeigt", hook: () => "Werte stehen bei uns nicht an der Wand." },
    { recipe: "tpl-verwurzelt-in-der-region", area: -1, outdoor: true, place: () => "Außen (Region)", title: c => c.town ? `Aus ${c.town}, für die Region` : "Verwurzelt in der Region", hook: () => "Von hier. Für hier." },
    { recipe: "tpl-ein-tag-im-unternehmen", area: 0, title: c => `Ein Tag bei uns${inTown(c)}`, hook: () => "So sieht ein ganz normaler Arbeitstag bei uns aus." },
  ],
};

function context(i: Input, trade: Trade | null): Ctx {
  const job = i.job_titles?.[0] ?? trade?.job ?? "Fachkraft";
  return {
    job, apprenticeship: trade && !i.job_titles ? trade.apprenticeship : `Ausbildung als ${job}`,
    areas: i.locations ?? trade?.areas ?? ["Arbeitsbereich", "Werkstatt", "Büro"],
    activity: trade?.activities[0] ?? "Die typische Arbeit", product: trade?.product ?? "Produkt", tool: trade?.tool ?? "dieses Werkzeug",
    town: i.town ?? null, label: trade?.label ?? i.industry ?? "unser Betrieb", outdoorWork: trade?.outdoorWork ?? null,
  };
}

const recipeById = (id: string | undefined) => (id ? recipeDataset.recipes.find(r => r.id === id) : undefined);
interface Reel {
  key: string; title: string; hook: string | null; source: "customer" | "suggestion"; recipe_id: string | null;
  location: string; outdoor: boolean; setup_type: (typeof SETUPS)[number]; recording_minutes: number; people: string;
  shots: string[]; questions: string[]; equipment: string[];
}
function candidates(i: Input, c: Ctx): Reel[] {
  const own: Omit<Reel, "key">[] = (i.reels ?? []).map(r => {
    const recipe = recipeById(r.recipe_id);
    return {
      title: r.title, hook: recipe?.hook ?? null, source: "customer" as const, recipe_id: recipe?.id ?? null,
      location: r.location ?? (r.outdoor ? "Außen" : c.areas[0]!), outdoor: r.outdoor ?? false, setup_type: recipe?.setup ?? "mixed",
      recording_minutes: r.recording_minutes ?? recipe?.shootMinutes ?? 30, people: r.people ?? recipe?.peopleHint ?? "Mitarbeitende",
      shots: recipe?.shots.slice(0, 6) ?? [], questions: recipe?.questions.slice(0, 5) ?? [], equipment: recipe?.equipment ?? [],
    };
  });
  const taken = new Set(own.map(r => norm(r.title)));
  const suggested: Omit<Reel, "key">[] = IDEAS[i.goal].filter(t => recipeById(t.recipe) && (!t.needs || t.needs(c))).map(t => {
    const recipe = recipeById(t.recipe)!;
    return {
      title: t.title(c), hook: t.hook(c), source: "suggestion" as const, recipe_id: recipe.id,
      location: t.place?.(c) ?? (t.area < 0 ? (c.outdoorWork ?? "Außen") : c.areas[t.area % c.areas.length]!), outdoor: t.outdoor ?? false,
      setup_type: recipe.setup, recording_minutes: recipe.shootMinutes, people: recipe.peopleHint,
      shots: recipe.shots.slice(0, 6), questions: recipe.questions.slice(0, 5), equipment: recipe.equipment,
    };
  }).filter(r => !taken.has(norm(r.title)));
  return [...own, ...suggested].map((r, n) => ({ ...r, key: `r${n + 1}` }));
}

/* ---------- one shoot day in a fixed window ---------- */
const RANK: Record<string, number> = { interview: 0, screen: 1, mixed: 2, detail: 3, broll: 4 };
type Row = { start: string; end: string; minutes: number; label: string; kind: "setup" | "move" | "pause" | "shoot"; reel: string | null; people: string | null };
function shootDay(reels: Reel[], startMin: number, lunch: number) {
  // Outdoor first (daylight is short in winter), then by area in order of appearance, inside an area quiet interviews first.
  const areas: string[] = [];
  for (const r of reels) { const k = norm(r.location); if (!areas.includes(k)) areas.push(k); }
  const ordered = reels.slice().sort((a, b) => Number(b.outdoor) - Number(a.outdoor) || areas.indexOf(norm(a.location)) - areas.indexOf(norm(b.location)) || (RANK[a.setup_type] ?? 2) - (RANK[b.setup_type] ?? 2));
  const rows: Row[] = []; let t = startMin, sinceBreak = 0, lunched = lunch === 0;
  const add = (label: string, minutes: number, kind: Row["kind"], r?: Reel) => {
    rows.push({ start: hhmm(t), end: hhmm(t + minutes), minutes, label, kind, reel: r?.key ?? null, people: r?.people ?? null });
    t += minutes; sinceBreak = kind === "pause" ? 0 : sinceBreak + minutes;
  };
  add("Ankommen, Aufbau & Technik-Check", 30, "setup");
  ordered.forEach((r, n) => {
    const prev = ordered[n - 1];
    if (prev) {
      if (!lunched && ((t >= 11 * 60 + 30 && t <= 14 * 60 && t - startMin >= 120) || t - startMin >= 300)) { add("Mittagspause", lunch, "pause"); lunched = true; }
      else if (sinceBreak >= 120) add("Kurze Pause", 15, "pause");
      if (norm(prev.location) !== norm(r.location)) add(`Ortswechsel → ${r.location}`, 20, "move");
      else if (prev.setup_type !== r.setup_type) add("Licht und Kamera umbauen", 10, "move");
    }
    add(r.title, r.recording_minutes + 10, "shoot", r); // +10: briefing, retakes, reset
  });
  add("Abbau & Datensicherung", 30, "setup");
  return { ordered, rows, end: t };
}

/* ---------- post-production on working days ---------- */
const offDay = (d: string, hol: Map<string, string>) => isWeekend(d) || hol.has(d) || d.endsWith("-12-24") || d.endsWith("-12-31");
function holidaysFor(from: string, to: string) {
  const all = new Map<string, string>();
  for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)) + 1; y++) for (const [d, n] of bavarianHolidays(y)) all.set(d, n);
  return all;
}
function workdays(start: string, n: number, hol: Map<string, string>) {
  let d = start; while (offDay(d, hol)) d = addDays(d, 1);
  const first = d; let left = n - 1;
  while (left > 0) { d = addDays(d, 1); if (!offDay(d, hol)) left--; }
  return { first, last: d };
}

function postProduction(i: Input, n: number, rounds: number, hol: Map<string, string>) {
  const steps: { step: string; label: string; owner: "agency" | "customer"; days: number }[] = [
    { step: "backup", label: "Datensicherung und Sichtung", owner: "agency", days: 1 },
    { step: "first_cut", label: `Erster Schnitt aller ${n} Reels`, owner: "agency", days: Math.ceil(n / i.edit_reels_per_day) },
  ];
  for (let r = 1; r <= rounds; r++) {
    steps.push({ step: `feedback_${r}`, label: `Feedback-Runde ${r} (Kunde)`, owner: "customer", days: i.client_feedback_days });
    steps.push({ step: `revision_${r}`, label: `Korrekturen Runde ${r}`, owner: "agency", days: Math.max(1, Math.ceil(n / (i.edit_reels_per_day * 2))) });
  }
  steps.push({ step: "final", label: "Finalisierung: Untertitel, Musiklizenzen, Export 9:16", owner: "agency", days: 1 });
  let cursor = addDays(i.shoot_date, 1);
  const milestones = steps.map(s => { const w = workdays(cursor, s.days, hol); cursor = addDays(w.last, 1); return { step: s.step, label_de: s.label, owner: s.owner, start: w.first, end: w.last, working_days: s.days }; });
  const ready = milestones[milestones.length - 1]!.end;
  let buffer = 0; for (let d = addDays(ready, 1); d <= i.deliver_by; d = addDays(d, 1)) if (!offDay(d, hol)) buffer++;
  return { milestones, ready, buffer };
}

export function plan(i: Input) {
  const today = i.today ?? berlinToday();
  const trade = matchTrade(i.industry);
  const ctx = context(i, trade);
  const warnings: string[] = [];
  const all = candidates(i, ctx);
  const own = all.filter(r => r.source === "customer").length;
  const wantMin = Math.max(i.reel_count_min, own), wantMax = Math.max(i.reel_count_max ?? i.reel_count_min, wantMin);
  const startMin = toMin(i.day_start), endMin = toMin(i.day_end);
  if (all.length < wantMin) warnings.push(`Für dieses Ziel gibt es ${all.length} passende Ideen; geplant werden ${all.length}. Eigene Ideen über "reels" ergänzen.`);

  // As many reels as fit into the window, at least the minimum.
  let n = Math.min(wantMax, all.length);
  let day = shootDay(all.slice(0, n), startMin, i.lunch_minutes);
  while (day.end > endMin && n > Math.min(wantMin, all.length)) { n--; day = shootDay(all.slice(0, n), startMin, i.lunch_minutes); }
  const planned = all.slice(0, n);
  let fitting = n; while (fitting > 0 && shootDay(all.slice(0, fitting), startMin, i.lunch_minutes).end > endMin) fitting--;
  if (day.end > endMin) warnings.push(`Ins Zeitfenster passen ${fitting} Reels. ${n} Reels brauchen bis ${hhmm(day.end)} Uhr, ${day.end - endMin} Minuten länger als bis ${i.day_end} Uhr möglich. Weniger Reels, kürzere Aufnahmen oder ein zweiter Drehtag.`);
  else if (n < wantMax) warnings.push(`Bis ${i.day_end} Uhr passen ${n} statt ${wantMax} Reels. Die übrigen stehen als Reserve bereit.`);
  const reserve = all.slice(n, Math.max(n, wantMax) + 3).map(r => ({ key: r.key, title: r.title, recipe_id: r.recipe_id, recording_minutes: r.recording_minutes, why: r.source === "customer" ? "Passt zeitlich nicht mehr in den Drehtag." : "Weitere Idee, falls Zeit bleibt oder für einen späteren Dreh." }));

  // Daylight for outdoor shots.
  const sun = i.latitude !== undefined && i.longitude !== undefined ? sunTimes(i.latitude, i.longitude, i.shoot_date) : null;
  const outdoorRows = day.rows.filter(r => r.kind === "shoot" && planned.find(p => p.key === r.reel)?.outdoor);
  if (outdoorRows.length && sun?.sunset) {
    const late = outdoorRows.filter(r => toMin(r.end) > toMin(sun.sunset!) - 30);
    if (late.length) warnings.push(`Außenaufnahmen enden nach ${hhmm(toMin(sun.sunset) - 30)} Uhr (Sonnenuntergang ${sun.sunset}). Früher einplanen oder Licht mitnehmen.`);
    if (sun.sunrise && outdoorRows.some(r => toMin(r.start) < toMin(sun.sunrise!) + 15)) warnings.push(`Außenaufnahmen beginnen vor ${hhmm(toMin(sun.sunrise) + 15)} Uhr (Sonnenaufgang ${sun.sunrise}): später starten oder Licht mitnehmen.`);
  } else if (outdoorRows.length && !sun) warnings.push("Für Außenaufnahmen latitude und longitude mitsenden: dann werden Sonnenauf- und -untergang geprüft.");
  if (diffDays(today, i.shoot_date) < 7) warnings.push("Der Dreh ist in weniger als einer Woche: Einwilligungen und Drehorte sofort klären.");

  // Call sheet by role.
  const roles = new Map<string, string[]>();
  for (const r of day.rows) if (r.kind === "shoot" && r.people) roles.set(r.people, [...(roles.get(r.people) ?? []), `${r.start}–${r.end}`]);
  const callSheet = [...roles].map(([role, times]) => ({ role, times, reels: day.rows.filter(r => r.people === role && r.reel).map(r => r.reel!) }));

  // Post-production up to delivery.
  const hol = holidaysFor(i.shoot_date, i.deliver_by);
  const post = (rounds: number) => postProduction(i, n, rounds, hol);
  const { milestones, ready, buffer } = post(i.review_rounds);
  if (ready > i.deliver_by) {
    let late = 0; for (let d = addDays(i.deliver_by, 1); d <= ready; d = addDays(d, 1)) if (!offDay(d, hol)) late++;
    const fewer = i.review_rounds > 0 ? post(i.review_rounds - 1) : null;
    warnings.push(`Mit ${i.review_rounds} Feedback-Runde(n) ist alles erst am ${ready} fertig, ${late} Arbeitstage nach dem ${i.deliver_by}.${fewer ? ` Mit ${i.review_rounds - 1} Runde(n): fertig am ${fewer.ready}.` : ""} Sonst kürzere Feedbackzeit, mehr Schnitttage pro Woche oder Abgabe in zwei Etappen.`);
  } else if (buffer < 2) warnings.push(`Nur ${buffer} Arbeitstag(e) Puffer vor der Abgabe am ${i.deliver_by}.`);
  const holidaysInRange = [...hol].filter(([d]) => d > i.shoot_date && d <= i.deliver_by).map(([date, name]) => ({ date, name }));

  const checklist = [
    "Schriftliche Einwilligung aller gefilmten Personen (DSGVO); bei Minderjährigen zusätzlich die Eltern.",
    ...(i.goal === "recruiting" ? ["Link oder Ansprechpartner für Bewerbungen festlegen: jedes Reel endet mit einem klaren Aufruf.", "Arbeitszeiten, Benefits und Einstiegsmöglichkeiten vorher erfragen: das interessiert Bewerber am meisten."] : []),
    "Interviewfragen vorab an die Beteiligten schicken, Antworten aber frei sprechen lassen.",
    "Arbeitsplätze aufräumen, Firmenkleidung bereitlegen, Kundendaten und Bildschirme aus dem Bild nehmen.",
    ...(trade?.safety ?? ["Sicherheitsregeln des Betriebs mit dem Ansprechpartner vor Ort klären."]),
    "Akkus, Speicherkarten, Ansteckmikrofone und Stativ prüfen; Material noch am Drehtag doppelt sichern.",
    "Untertitel einplanen: die meisten Reels werden ohne Ton geschaut.",
  ];
  const nextSteps = [
    ...(i.latitude !== undefined ? [`Wetter und Schutzgebiete: shoot-location-check ab ${addDays(i.shoot_date, -9)} abrufen (Vorhersage höchstens 10 Tage).`] : []),
    "Vollständige Shotlisten und Hook-Alternativen: video-recipes mit der recipe_id eines Reels.",
    "Veröffentlichung nach der Abgabe verteilen: Termine als posts an content-plan-shift geben oder content-month-plan nutzen.",
  ];

  const planId = createHash("sha256").update(JSON.stringify({ i, today })).digest("hex").slice(0, 12);
  const reels = day.ordered.map(r => { const row = day.rows.find(x => x.reel === r.key)!; return { ...r, slot: { start: row.start, end: row.end } }; });
  return {
    language: "de", plan_id: planId, today,
    project: { goal: i.goal, industry: i.industry ?? null, trade_matched: trade?.label ?? null, job: ctx.job, town: i.town ?? null, shoot_date: i.shoot_date, window: { start: i.day_start, end: i.day_end }, deliver_by: i.deliver_by },
    summary: {
      reels_planned: n, reels_from_customer: Math.min(own, n), reserve: reserve.length,
      shoot_day: { start: i.day_start, end: hhmm(day.end), fits_window: day.end <= endMin, day_minutes: day.end - startMin, recording_minutes: planned.reduce((a, r) => a + r.recording_minutes, 0) },
      ready_for_delivery: ready, buffer_working_days: buffer, on_time: ready <= i.deliver_by,
    },
    reels, reserve,
    shoot_day: { date: i.shoot_date, schedule: day.rows, call_sheet: callSheet, sun },
    post_production: { milestones, ready_for_delivery: ready, deliver_by: i.deliver_by, buffer_working_days: buffer, holidays_in_range: holidaysInRange, non_working: "Weekends, Bavarian public holidays, 24 and 31 December." },
    checklist, warnings, next_steps: nextSteps,
    calendar_file_ics: ics(planId, today, i, day.rows, hhmm(day.end), milestones),
    coverage: "Rule-based plan from your inputs, built-in recipes and a small trade vocabulary; ideas are suggestions, not a creative concept. Durations are typical values (recording time plus 10 minutes per reel, 30 min set-up, 30 min teardown). No weather, travel, people's availability or legal clearance. Holidays: Bavaria. Nothing is stored or written to any calendar.",
  };
}

type Milestone = { step: string; label_de: string; start: string; end: string };
function ics(planId: string, today: string, i: Input, rows: Row[], end: string, milestones: Milestone[]): string {
  const day = (d: string) => d.replace(/-/g, ""), time = (d: string, t: string) => `${day(d)}T${t.replace(":", "")}00`, stamp = `${day(today)}T000000Z`;
  const events = [
    ["BEGIN:VEVENT", `UID:${planId}-shoot@agent.chiemgaufilms.com`, `DTSTAMP:${stamp}`, `DTSTART:${time(i.shoot_date, i.day_start)}`, `DTEND:${time(toMin(end) <= toMin(i.day_start) ? addDays(i.shoot_date, 1) : i.shoot_date, end)}`,
      `SUMMARY:${icsEscape(`Drehtag${i.town ? ` ${i.town}` : ""}: ${rows.filter(r => r.kind === "shoot").length} Reels`)}`,
      `DESCRIPTION:${icsEscape(rows.map(r => `${r.start}–${r.end} ${r.label}`).join("\n"))}`, "CATEGORIES:Dreh", "END:VEVENT"],
    ...milestones.map(m => ["BEGIN:VEVENT", `UID:${planId}-${m.step}@agent.chiemgaufilms.com`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${day(m.start)}`,
      `DTEND;VALUE=DATE:${day(addDays(m.end, 1))}`, `SUMMARY:${icsEscape(m.label_de)}`, "CATEGORIES:Postproduktion", "END:VEVENT"]),
    ["BEGIN:VEVENT", `UID:${planId}-delivery@agent.chiemgaufilms.com`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${day(i.deliver_by)}`,
      `DTEND;VALUE=DATE:${day(addDays(i.deliver_by, 1))}`, "SUMMARY:Abgabe an den Kunden", "CATEGORIES:Abgabe", "END:VEVENT"],
  ];
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Chiemgau Films Agent Data API//Video Project Plan//DE", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", ...events.flat(), "END:VCALENDAR"].map(icsFold).join("\r\n") + "\r\n";
}

const exampleInput = { goal: "recruiting", industry: "Metallbau", town: "Chieming", shoot_date: "2026-11-20", day_start: "08:00", day_end: "17:00", deliver_by: "2026-12-23", reel_count_min: 5, reel_count_max: 10, latitude: 47.89, longitude: 12.54, today: "2026-10-24" };
const example: Input = inputSchema.parse(exampleInput);
export const videoProjectPlan: ServiceDefinition<Input, ReturnType<typeof plan>> = {
  id: cfg.id, name: cfg.name, route: cfg.route, priceUsdc: cfg.priceUsdc, enabled: cfg.enabled,
  cacheTtlSeconds: cfg.cacheTtlSeconds, limits: { maxInputs: cfg.maxInputs, maxResults: cfg.maxResults },
  upstream: { endpoint: cfg.dataforseoEndpoint, maxCostUsd: cfg.maxUpstreamCostUsd },
  summary: "One call, one video job: reel ideas for goal, trade and town (or your own), one shoot day inside your time window, call sheet, sun times and post-production up to your delivery date. Warnings, checklist, .ics.",
  notice: "Rule-based, German content, no AI model, stateless. Send roles, areas and the company's town only, no personal names or private addresses. Ideas are suggestions; durations are typical values you can override per reel. Nothing is written to any calendar.",
  inputSchema, estimateCostUsd: () => 0,
  validateInput: i => {
    const today = i.today ?? berlinToday();
    if (i.shoot_date < today) return `shoot_date ${i.shoot_date} is in the past.`;
    if (i.deliver_by <= i.shoot_date) return "deliver_by must be after shoot_date.";
    if (diffDays(i.shoot_date, i.deliver_by) > 180) return "deliver_by may be at most 180 days after shoot_date.";
    if (toMin(i.day_end) - toMin(i.day_start) < 240) return "The shoot window must be at least 4 hours.";
    const bad = i.reels?.find(r => r.recipe_id && !recipeById(r.recipe_id));
    return bad ? `Unknown recipe_id "${bad.recipe_id}". List valid ids with the video-recipes service.` : null;
  },
  buildRequest: i => [i], mapResult: (_task, i) => plan(i), executeLocal: plan,
  example: exampleInput as unknown as Input, outputExample: compactExample(plan(example), 1, 20),
};
