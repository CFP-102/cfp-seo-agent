import { createHash } from "node:crypto";
import { z } from "zod";
import { PLAN_LIMITS, serviceConfig } from "../config/services.js";
import { plain } from "./common.js";
import { addDays, bavarianHolidays, berlinToday, diffDays, isWeekend, isoDate } from "./dates.js";
import { compactExample } from "./exampleCompact.js";
import { hhmm, icsEscape, icsFold, norm, toMin } from "./shootPlan.js";
import { sunTimes } from "./sunTimes.js";
import { languageInput, tr, type Lang } from "./i18n.js";
import { matchTrade, tradeText, type Trade } from "./trades.js";
import { recipeIn } from "./videoRecipes.js";
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
/** English aliases for the goal ids. */
const GOAL_ALIAS: Record<string, Goal> = { product: "produkt", company: "unternehmen" };
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
  goal: z.enum([...GOALS, "product", "company"]),
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
  latitude: z.number().min(47.2).max(55.1).optional(),
  longitude: z.number().min(5.8).max(15.1).optional(),
  lunch_minutes: z.number().int().min(0).max(90).default(45),
  review_rounds: z.number().int().min(0).max(3).default(2),
  client_feedback_days: z.number().int().min(1).max(10).default(3),
  edit_reels_per_day: z.number().int().min(1).max(8).default(3),
  today: isoDate.optional(),
  language: languageInput,
}).refine(d => (d.latitude === undefined) === (d.longitude === undefined), { message: "Send latitude and longitude together", path: ["longitude"] })
  .refine(d => d.reel_count_max === undefined || d.reel_count_max >= d.reel_count_min, { message: "reel_count_max must not be below reel_count_min", path: ["reel_count_max"] });
type Input = z.output<typeof inputSchema>;

/* ---------- ideas ---------- */
interface Ctx { lang: Lang; job: string; apprenticeship: string; areas: string[]; activity: string; product: string; tool: string; town: string | null; label: string; outdoorWork: string | null }
type Text = (c: Ctx) => string;
/** One idea: recipe for shots and timing, title and hook in German (de) and English (en). */
interface IdeaTpl { recipe: string; de: [Text, Text]; en: [Text, Text]; area: number; outdoor?: boolean; place?: Text; needs?: (c: Ctx) => boolean }
const inTown = (c: Ctx, word = "in") => (c.town ? ` ${word} ${c.town}` : "");
const k = (s: string): Text => () => s;
export const IDEAS: Record<Goal, IdeaTpl[]> = {
  recruiting: [
    { recipe: "tpl-azubi-interview", area: 0, de: [c => `Azubi erzählt: Warum ${c.job}?`, c => `Warum ich ${c.job} geworden bin – ganz ehrlich.`], en: [c => `Apprentice explains: why ${c.job}?`, c => `Why I became a ${c.job}, honestly.`] },
    { recipe: "tpl-neuer-arbeitsplatz", area: 0, de: [c => `Dein Arbeitsplatz: unsere ${c.areas[0]}${inTown(c)}`, k("Hier könnte ab nächstem Monat dein Arbeitsplatz sein.")], en: [c => `Your workplace: our ${c.areas[0]!.toLowerCase()}${inTown(c)}`, k("This could be your workplace next month.")] },
    { recipe: "tpl-ausbildungsberuf-vorstellen", area: 0, de: [c => `Das lernst du in der ${c.apprenticeship}`, c => `Nach der Schule keinen Plan? ${c.job} ist mehr, als du denkst.`], en: [c => `What you learn in an ${c.apprenticeship}`, c => `No plan after school? Being a ${c.job} is more than you think.`] },
    { recipe: "tpl-maschine-in-aktion", area: 1, de: [c => `${c.activity} – so sieht das in echt aus`, c => `Hättest du gedacht, dass ${c.activity} so aussieht?`], en: [c => `${c.activity}: what it really looks like`, c => `Did you know ${c.activity.toLowerCase()} looks like this?`] },
    { recipe: "tpl-teamvorstellung", area: 0, de: [c => `Das Team${inTown(c, "aus")} stellt sich vor`, k("Das sind die Leute, mit denen du jeden Tag arbeitest.")], en: [c => `Meet the team${inTown(c, "from")}`, k("These are the people you'd work with every day.")] },
    { recipe: "tpl-mythos-vs-realitaet", area: 0, de: [c => `Mythos vs. Realität: ${c.job}`, c => `„${c.job}? Das ist doch nur …“ – stimmt so nicht.`], en: [c => `Myth vs. reality: ${c.job}`, c => `"A ${c.job}? That's just …" Not quite.`] },
    { recipe: "tpl-blick-hinter-die-kulissen", area: 1, de: [c => `Vom Rohmaterial zum fertigen ${c.product}`, c => `Vom Rohmaterial zum fertigen ${c.product} – in 30 Sekunden.`], en: [c => `From raw material to finished ${c.product}`, c => `From raw material to finished ${c.product} in 30 seconds.`] },
    { recipe: "tpl-3-tipps-vom-experten", area: 2, de: [c => `3 Gründe, bei uns ${c.job} zu werden`, k("Drei Gründe, warum du bei uns anfangen solltest.")], en: [c => `3 reasons to become a ${c.job} with us`, k("Three reasons to start with us.")] },
    { recipe: "tpl-werkzeug-erklaert", area: 1, de: [c => `Ohne ${c.tool} geht nichts`, c => `Das ist unser wichtigstes Werkzeug: ${c.tool}.`], en: [c => `Nothing works without our ${c.tool}`, c => `This is our most important tool: the ${c.tool}.`] },
    { recipe: "tpl-blick-hinter-die-kulissen", area: -1, outdoor: true, needs: c => c.outdoorWork !== null, de: [c => `Unterwegs: ${c.outdoorWork}`, k("Nicht nur in der Halle: so sieht ein Einsatz draußen aus.")], en: [c => `On the road: ${c.outdoorWork}`, k("Not just in the workshop: this is what a job outside looks like.")] },
    { recipe: "tpl-bewerbung-in-60-sekunden", area: 2, de: [k("Bewerben in 60 Sekunden – so einfach geht's"), k("Bewerben bei uns? Dauert keine 5 Minuten.")], en: [k("Apply in 60 seconds: this is how easy it is"), k("Applying to us? Takes less than 5 minutes.")] },
    { recipe: "tpl-ausbilder-stellt-sich-vor", area: 0, de: [k("Dein Ausbilder stellt sich vor"), k("Ich bin der, der dir hier alles beibringt.")], en: [k("Meet your trainer"), k("I'm the one who'll teach you everything here.")] },
    { recipe: "tpl-pov-job", area: 1, de: [c => `POV: Dein erster Tag als ${c.job}`, k("POV: Du bist ab heute bei uns.")], en: [c => `POV: your first day as a ${c.job}`, k("POV: you start with us today.")] },
    { recipe: "tpl-klartext-arbeitszeit", area: 2, de: [k("Klartext: Arbeitszeit, Urlaub, Gehalt"), k("Die Fragen, die sich keiner traut – hier die Antworten.")], en: [k("Straight talk: hours, holidays, pay"), k("The questions nobody dares to ask, answered.")] },
    { recipe: "tpl-erster-arbeitstag", area: 0, de: [k("Dein erster Arbeitstag bei uns"), k("Das passiert an deinem ersten Tag bei uns.")], en: [k("Your first day with us"), k("This is what happens on your first day.")] },
    { recipe: "tpl-azubi-pruefungsstueck", area: 0, de: [k("Prüfungsstück: Das hat unser Azubi gebaut"), k("Das hat unser Azubi ganz allein gebaut.")], en: [k("Exam piece: built by our apprentice"), k("Our apprentice built this all alone.")] },
    { recipe: "tpl-quereinsteiger", area: 0, de: [c => `Quereinstieg als ${c.job}`, k("Früher war ich ganz woanders. Heute bin ich hier.")], en: [c => `Career change: now a ${c.job}`, k("I used to do something completely different. Now I'm here.")] },
    { recipe: "tpl-benefits-gezeigt", area: 0, de: [k("Benefits, die man sehen kann"), k("Was es bei uns gibt – nicht nur auf dem Papier.")], en: [k("Benefits you can actually see"), k("What you get with us, not just on paper.")] },
    { recipe: "tpl-neuer-mitarbeiter", area: 2, de: [k("Erste Woche im Team"), k("Meine erste Woche hier – das hätte ich nicht erwartet.")], en: [k("First week on the team"), k("My first week here: I didn't expect this.")] },
    { recipe: "tpl-ein-tag-im-unternehmen", area: 0, de: [c => `Ein Tag als ${c.job}${inTown(c)}`, c => `Ein ganz normaler Tag als ${c.job}.`], en: [c => `A day as a ${c.job}${inTown(c)}`, c => `A completely normal day as a ${c.job}.`] },
  ],
  produkt: [
    { recipe: "tpl-produkt-in-30-sekunden", area: 0, de: [c => `Unser ${c.product} in 30 Sekunden`, c => `Was macht ein gutes ${c.product} aus? 30 Sekunden.`], en: [c => `Our ${c.product} in 30 seconds`, c => `What makes a good ${c.product}? 30 seconds.`] },
    { recipe: "tpl-schritt-fuer-schritt", area: 1, de: [c => `Schritt für Schritt: so entsteht ein ${c.product}`, k("Vom ersten Schritt bis zum fertigen Ergebnis.")], en: [c => `Step by step: how a ${c.product} is made`, k("From the first step to the finished result.")] },
    { recipe: "tpl-produktdetail", area: 0, de: [k("Details, die man nur aus der Nähe sieht"), k("Auf diese Details achten die wenigsten.")], en: [k("Details you only see up close"), k("Hardly anyone notices these details.")] },
    { recipe: "tpl-maschine-in-aktion", area: 1, de: [c => `${c.activity} in Aktion`, k("Hättest du gedacht, dass das so schnell geht?")], en: [c => `${c.activity} in action`, k("Did you think it would be this fast?")] },
    { recipe: "tpl-werkzeug-erklaert", area: 1, de: [c => `Ohne ${c.tool} geht nichts`, c => `Das ist unser wichtigstes Werkzeug: ${c.tool}.`], en: [c => `Nothing works without our ${c.tool}`, c => `This is our most important tool: the ${c.tool}.`] },
    { recipe: "tpl-fehler-die-kunden-machen", area: 0, de: [c => `3 Fehler beim Kauf von ${c.product}`, k("Diese Fehler sehen wir immer wieder.")], en: [c => `3 mistakes when buying a ${c.product}`, k("We see these mistakes again and again.")] },
    { recipe: "tpl-kundenfragen", area: 2, de: [k("Die häufigste Kundenfrage – beantwortet"), k("Diese Frage hören wir jede Woche.")], en: [k("Our most common customer question, answered"), k("We hear this question every week.")] },
    { recipe: "tpl-a-oder-b", area: 0, de: [k("A oder B? Der ehrliche Vergleich"), k("A oder B? Kommt drauf an – und zwar darauf.")], en: [k("A or B? The honest comparison"), k("A or B? It depends, and here's on what.")] },
    { recipe: "tpl-auftrag-ablauf", area: 2, de: [k("So läuft ein Auftrag bei uns ab"), k("Von der Anfrage bis zur Übergabe – so läuft es.")], en: [k("How a job with us works"), k("From enquiry to handover: this is how it works.")] },
    { recipe: "tpl-pflegetipp", area: 1, de: [c => `Pflege-Tipp: So hält dein ${c.product} länger`, k("Mit diesem Trick hält es doppelt so lange.")], en: [c => `Care tip: make your ${c.product} last longer`, k("This trick makes it last twice as long.")] },
    { recipe: "tpl-vorher-nachher", area: -1, outdoor: true, needs: c => c.outdoorWork !== null, de: [k("Vorher / Nachher beim Kunden"), k("Vorher – nachher. Muss man mehr sagen?")], en: [k("Before / after at the customer's"), k("Before, after. Need we say more?")] },
  ],
  unternehmen: [
    { recipe: "tpl-unternehmensgeschichte", area: 2, de: [c => `Wie alles anfing: ${c.label}${inTown(c, "aus")}`, k("So hat bei uns alles angefangen.")], en: [c => `How it all began: ${c.label}${inTown(c, "from")}`, k("This is how it all started.")] },
    { recipe: "tpl-teamvorstellung", area: 0, de: [c => `Das Team${inTown(c, "aus")} stellt sich vor`, k("Das sind die Menschen hinter unserer Arbeit.")], en: [c => `Meet the team${inTown(c, "from")}`, k("These are the people behind our work.")] },
    { recipe: "tpl-zahlen-und-fakten", area: 0, de: [k("Unser Betrieb in Zahlen"), k("Ein paar Zahlen, die uns selbst überrascht haben.")], en: [k("Our company in numbers"), k("A few numbers that surprised even us.")] },
    { recipe: "tpl-blick-hinter-die-kulissen", area: 1, de: [k("Blick hinter die Kulissen"), k("Das sehen unsere Kunden normalerweise nie.")], en: [k("Behind the scenes"), k("Our customers normally never see this.")] },
    { recipe: "tpl-mitarbeiter-vorstellen", area: 0, de: [k("Wer steckt eigentlich dahinter?"), k("Ohne diese Person läuft hier nichts.")], en: [k("Who's actually behind it?"), k("Nothing runs here without this person.")] },
    { recipe: "tpl-chef-antwortet", area: 2, de: [k("Der Chef antwortet"), k("Ihr habt gefragt – der Chef antwortet.")], en: [k("The boss answers"), k("You asked, the boss answers.")] },
    { recipe: "tpl-werte-im-alltag", area: 0, de: [k("Unsere Werte – im Alltag gezeigt"), k("Werte stehen bei uns nicht an der Wand.")], en: [k("Our values, shown in daily work"), k("Our values aren't just on the wall.")] },
    { recipe: "tpl-verwurzelt-in-der-region", area: -1, outdoor: true, place: c => tr(c.lang, "Außen (Region)", "Outdoors (region)"), de: [c => c.town ? `Aus ${c.town}, für die Region` : "Verwurzelt in der Region", k("Von hier. Für hier.")], en: [c => c.town ? `From ${c.town}, for the region` : "Rooted in the region", k("From here. For here.")] },
    { recipe: "tpl-ein-tag-im-unternehmen", area: 0, de: [c => `Ein Tag bei uns${inTown(c)}`, k("So sieht ein ganz normaler Arbeitstag bei uns aus.")], en: [c => `A day with us${inTown(c)}`, k("This is what a normal working day looks like here.")] },
  ],
};

function context(i: Input, trade: Trade | null): Ctx {
  const lang = i.language, t$ = (de: string, en: string) => tr(lang, de, en), tt = trade ? tradeText(trade, lang) : null;
  const job = i.job_titles?.[0] ?? tt?.job ?? t$("Fachkraft", "skilled worker");
  return {
    lang, job, apprenticeship: tt && !i.job_titles ? tt.apprenticeship : t$(`Ausbildung als ${job}`, `apprenticeship as a ${job}`),
    areas: i.locations ?? tt?.areas ?? (lang === "en" ? ["Work area", "Workshop", "Office"] : ["Arbeitsbereich", "Werkstatt", "Büro"]),
    activity: tt?.activities[0] ?? t$("Die typische Arbeit", "The typical work"), product: tt?.product ?? t$("Produkt", "product"), tool: tt?.tool ?? t$("dieses Werkzeug", "this tool"),
    town: i.town ?? null, label: tt?.label ?? i.industry ?? t$("unser Betrieb", "our company"), outdoorWork: tt?.outdoorWork ?? null,
  };
}

const recipeById = (id: string | undefined, lang: Lang = "de") => recipeIn(lang, id);
interface Reel {
  key: string; title: string; hook: string | null; source: "customer" | "suggestion"; recipe_id: string | null;
  location: string; outdoor: boolean; setup_type: (typeof SETUPS)[number]; recording_minutes: number; people: string;
  shots: string[]; questions: string[]; equipment: string[];
}
function candidates(i: Input, c: Ctx): Reel[] {
  const own: Omit<Reel, "key">[] = (i.reels ?? []).map(r => {
    const recipe = recipeById(r.recipe_id, c.lang);
    return {
      title: r.title, hook: recipe?.hook ?? null, source: "customer" as const, recipe_id: recipe?.id ?? null,
      location: r.location ?? (r.outdoor ? tr(c.lang, "Außen", "Outdoors") : c.areas[0]!), outdoor: r.outdoor ?? false, setup_type: recipe?.setup ?? "mixed",
      recording_minutes: r.recording_minutes ?? recipe?.shootMinutes ?? 30, people: r.people ?? recipe?.peopleHint ?? tr(c.lang, "Mitarbeitende", "Staff"),
      shots: recipe?.shots.slice(0, 6) ?? [], questions: recipe?.questions.slice(0, 5) ?? [], equipment: recipe?.equipment ?? [],
    };
  });
  const taken = new Set(own.map(r => norm(r.title)));
  const suggested: Omit<Reel, "key">[] = IDEAS[GOAL_ALIAS[i.goal] ?? (i.goal as Goal)].filter(t => recipeById(t.recipe) && (!t.needs || t.needs(c))).map(t => {
    const recipe = recipeById(t.recipe, c.lang)!;
    const [title, hook] = t[c.lang];
    return {
      title: title(c), hook: hook(c), source: "suggestion" as const, recipe_id: recipe.id,
      location: t.place?.(c) ?? (t.area < 0 ? (c.outdoorWork ?? tr(c.lang, "Außen", "Outdoors")) : c.areas[t.area % c.areas.length]!), outdoor: t.outdoor ?? false,
      setup_type: recipe.setup, recording_minutes: recipe.shootMinutes, people: recipe.peopleHint,
      shots: recipe.shots.slice(0, 6), questions: recipe.questions.slice(0, 5), equipment: recipe.equipment,
    };
  }).filter(r => !taken.has(norm(r.title)));
  return [...own, ...suggested].map((r, n) => ({ ...r, key: `r${n + 1}` }));
}

/* ---------- one shoot day in a fixed window ---------- */
const RANK: Record<string, number> = { interview: 0, screen: 1, mixed: 2, detail: 3, broll: 4 };
type Row = { start: string; end: string; minutes: number; label: string; kind: "setup" | "move" | "pause" | "shoot"; reel: string | null; people: string | null };
function shootDay(reels: Reel[], startMin: number, lunch: number, lang: Lang) {
  const t$ = (de: string, en: string) => tr(lang, de, en);
  // Outdoor first (daylight is short in winter), then by area in order of appearance, inside an area quiet interviews first.
  const areas: string[] = [];
  for (const r of reels) { const k = norm(r.location); if (!areas.includes(k)) areas.push(k); }
  const ordered = reels.slice().sort((a, b) => Number(b.outdoor) - Number(a.outdoor) || areas.indexOf(norm(a.location)) - areas.indexOf(norm(b.location)) || (RANK[a.setup_type] ?? 2) - (RANK[b.setup_type] ?? 2));
  const rows: Row[] = []; let t = startMin, sinceBreak = 0, lunched = lunch === 0;
  const add = (label: string, minutes: number, kind: Row["kind"], r?: Reel) => {
    rows.push({ start: hhmm(t), end: hhmm(t + minutes), minutes, label, kind, reel: r?.key ?? null, people: r?.people ?? null });
    t += minutes; sinceBreak = kind === "pause" ? 0 : sinceBreak + minutes;
  };
  add(t$("Ankommen, Aufbau & Technik-Check", "Arrival, set-up & tech check"), 30, "setup");
  ordered.forEach((r, n) => {
    const prev = ordered[n - 1];
    if (prev) {
      if (!lunched && ((t >= 11 * 60 + 30 && t <= 14 * 60 && t - startMin >= 120) || t - startMin >= 300)) { add(t$("Mittagspause", "Lunch break"), lunch, "pause"); lunched = true; }
      else if (sinceBreak >= 120) add(t$("Kurze Pause", "Short break"), 15, "pause");
      if (norm(prev.location) !== norm(r.location)) add(`${t$("Ortswechsel", "Move")} → ${r.location}`, 20, "move");
      else if (prev.setup_type !== r.setup_type) add(t$("Licht und Kamera umbauen", "Reset lights and camera"), 10, "move");
    }
    add(r.title, r.recording_minutes + 10, "shoot", r); // +10: briefing, retakes, reset
  });
  add(t$("Abbau & Datensicherung", "Teardown & data backup"), 30, "setup");
  return { ordered, rows, end: t };
}

/* ---------- post-production on working days ---------- */
const HOLIDAY_EN: Record<string, string> = {
  "Neujahr": "New Year's Day", "Heilige Drei Könige": "Epiphany", "Karfreitag": "Good Friday", "Ostermontag": "Easter Monday", "Tag der Arbeit": "Labour Day",
  "Christi Himmelfahrt": "Ascension Day", "Pfingstmontag": "Whit Monday", "Fronleichnam": "Corpus Christi", "Mariä Himmelfahrt": "Assumption Day",
  "Tag der Deutschen Einheit": "German Unity Day", "Allerheiligen": "All Saints' Day", "1. Weihnachtstag": "Christmas Day", "2. Weihnachtstag": "Boxing Day",
};
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
  const t$ = (de: string, en: string) => tr(i.language, de, en);
  const steps: { step: string; label: string; owner: "agency" | "customer"; days: number }[] = [
    { step: "backup", label: t$("Datensicherung und Sichtung", "Backup and review of footage"), owner: "agency", days: 1 },
    { step: "first_cut", label: t$(`Erster Schnitt aller ${n} Reels`, `First cut of all ${n} reels`), owner: "agency", days: Math.ceil(n / i.edit_reels_per_day) },
  ];
  for (let r = 1; r <= rounds; r++) {
    steps.push({ step: `feedback_${r}`, label: t$(`Feedback-Runde ${r} (Kunde)`, `Feedback round ${r} (customer)`), owner: "customer", days: i.client_feedback_days });
    steps.push({ step: `revision_${r}`, label: t$(`Korrekturen Runde ${r}`, `Revisions round ${r}`), owner: "agency", days: Math.max(1, Math.ceil(n / (i.edit_reels_per_day * 2))) });
  }
  steps.push({ step: "final", label: t$("Finalisierung: Untertitel, Musiklizenzen, Export 9:16", "Finishing: subtitles, music licences, 9:16 export"), owner: "agency", days: 1 });
  let cursor = addDays(i.shoot_date, 1);
  const milestones = steps.map(s => { const w = workdays(cursor, s.days, hol); cursor = addDays(w.last, 1); return { step: s.step, label: s.label, owner: s.owner, start: w.first, end: w.last, working_days: s.days }; });
  const ready = milestones[milestones.length - 1]!.end;
  let buffer = 0; for (let d = addDays(ready, 1); d <= i.deliver_by; d = addDays(d, 1)) if (!offDay(d, hol)) buffer++;
  return { milestones, ready, buffer };
}

export function plan(i: Input) {
  const today = i.today ?? berlinToday();
  const lang = i.language, t$ = (de: string, en: string) => tr(lang, de, en);
  const trade = matchTrade(i.industry), tt = trade ? tradeText(trade, lang) : null;
  const ctx = context(i, trade);
  const warnings: string[] = [];
  const all = candidates(i, ctx);
  const own = all.filter(r => r.source === "customer").length;
  const wantMin = Math.max(i.reel_count_min, own), wantMax = Math.max(i.reel_count_max ?? i.reel_count_min, wantMin);
  const startMin = toMin(i.day_start), endMin = toMin(i.day_end);
  if (all.length < wantMin) warnings.push(t$(`Für dieses Ziel gibt es ${all.length} passende Ideen; geplant werden ${all.length}. Eigene Ideen über "reels" ergänzen.`, `There are ${all.length} matching ideas for this goal, so ${all.length} are planned. Add your own ideas via "reels".`));

  // As many reels as fit into the window, at least the minimum.
  let n = Math.min(wantMax, all.length);
  let day = shootDay(all.slice(0, n), startMin, i.lunch_minutes, lang);
  while (day.end > endMin && n > Math.min(wantMin, all.length)) { n--; day = shootDay(all.slice(0, n), startMin, i.lunch_minutes, lang); }
  const planned = all.slice(0, n);
  let fitting = n; while (fitting > 0 && shootDay(all.slice(0, fitting), startMin, i.lunch_minutes, lang).end > endMin) fitting--;
  if (day.end > endMin) warnings.push(t$(`Ins Zeitfenster passen ${fitting} Reels. ${n} Reels brauchen bis ${hhmm(day.end)} Uhr, ${day.end - endMin} Minuten länger als bis ${i.day_end} Uhr möglich. Weniger Reels, kürzere Aufnahmen oder ein zweiter Drehtag.`, `${fitting} reels fit into the window. ${n} reels need until ${hhmm(day.end)}, ${day.end - endMin} minutes longer than ${i.day_end} allows. Fewer reels, shorter recordings or a second shoot day.`));
  else if (n < wantMax) warnings.push(t$(`Bis ${i.day_end} Uhr passen ${n} statt ${wantMax} Reels. Die übrigen stehen als Reserve bereit.`, `${n} instead of ${wantMax} reels fit until ${i.day_end}. The others are listed as reserve.`));
  const reserve = all.slice(n, Math.max(n, wantMax) + 3).map(r => ({ key: r.key, title: r.title, recipe_id: r.recipe_id, recording_minutes: r.recording_minutes, why: r.source === "customer" ? t$("Passt zeitlich nicht mehr in den Drehtag.", "Does not fit into the shoot day any more.") : t$("Weitere Idee, falls Zeit bleibt oder für einen späteren Dreh.", "Further idea if time is left or for a later shoot.") }));

  // Daylight for outdoor shots.
  const sun = i.latitude !== undefined && i.longitude !== undefined ? sunTimes(i.latitude, i.longitude, i.shoot_date) : null;
  const outdoorRows = day.rows.filter(r => r.kind === "shoot" && planned.find(p => p.key === r.reel)?.outdoor);
  if (outdoorRows.length && sun?.sunset) {
    const late = outdoorRows.filter(r => toMin(r.end) > toMin(sun.sunset!) - 30);
    if (late.length) warnings.push(t$(`Außenaufnahmen enden nach ${hhmm(toMin(sun.sunset) - 30)} Uhr (Sonnenuntergang ${sun.sunset}). Früher einplanen oder Licht mitnehmen.`, `Outdoor shots end after ${hhmm(toMin(sun.sunset) - 30)} (sunset ${sun.sunset}). Plan them earlier or bring lights.`));
    if (sun.sunrise && outdoorRows.some(r => toMin(r.start) < toMin(sun.sunrise!) + 15)) warnings.push(t$(`Außenaufnahmen beginnen vor ${hhmm(toMin(sun.sunrise) + 15)} Uhr (Sonnenaufgang ${sun.sunrise}): später starten oder Licht mitnehmen.`, `Outdoor shots start before ${hhmm(toMin(sun.sunrise) + 15)} (sunrise ${sun.sunrise}): start later or bring lights.`));
  } else if (outdoorRows.length && !sun) warnings.push(t$("Für Außenaufnahmen latitude und longitude mitsenden: dann werden Sonnenauf- und -untergang geprüft.", "For outdoor shots, send latitude and longitude: sunrise and sunset are then checked."));
  if (diffDays(today, i.shoot_date) < 7) warnings.push(t$("Der Dreh ist in weniger als einer Woche: Einwilligungen und Drehorte sofort klären.", "The shoot is less than a week away: clarify consents and locations now."));

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
    warnings.push(t$(`Mit ${i.review_rounds} Feedback-Runde(n) ist alles erst am ${ready} fertig, ${late} Arbeitstage nach dem ${i.deliver_by}.${fewer ? ` Mit ${i.review_rounds - 1} Runde(n): fertig am ${fewer.ready}.` : ""} Sonst kürzere Feedbackzeit, mehr Schnitttage pro Woche oder Abgabe in zwei Etappen.`,
      `With ${i.review_rounds} feedback round(s) everything is ready only on ${ready}, ${late} working days after ${i.deliver_by}.${fewer ? ` With ${i.review_rounds - 1} round(s): ready on ${fewer.ready}.` : ""} Otherwise shorter feedback time, more editing days per week or delivery in two stages.`));
  } else if (buffer < 2) warnings.push(t$(`Nur ${buffer} Arbeitstag(e) Puffer vor der Abgabe am ${i.deliver_by}.`, `Only ${buffer} working day(s) of buffer before delivery on ${i.deliver_by}.`));
  const holidaysInRange = [...hol].filter(([d]) => d > i.shoot_date && d <= i.deliver_by).map(([date, name]) => ({ date, name: lang === "en" ? HOLIDAY_EN[name] ?? name : name }));

  const checklist = [
    t$("Schriftliche Einwilligung aller gefilmten Personen (DSGVO); bei Minderjährigen zusätzlich die Eltern.", "Written consent from everyone filmed (GDPR); for minors also from the parents."),
    ...(i.goal === "recruiting" ? [
      t$("Link oder Ansprechpartner für Bewerbungen festlegen: jedes Reel endet mit einem klaren Aufruf.", "Decide the application link or contact person: every reel ends with a clear call to action."),
      t$("Arbeitszeiten, Benefits und Einstiegsmöglichkeiten vorher erfragen: das interessiert Bewerber am meisten.", "Ask about working hours, benefits and entry options beforehand: that is what applicants care about most."),
    ] : []),
    t$("Interviewfragen vorab an die Beteiligten schicken, Antworten aber frei sprechen lassen.", "Send interview questions in advance, but let people answer freely."),
    t$("Arbeitsplätze aufräumen, Firmenkleidung bereitlegen, Kundendaten und Bildschirme aus dem Bild nehmen.", "Tidy workplaces, prepare company clothing, keep customer data and screens out of the frame."),
    ...(tt?.safety ?? [t$("Sicherheitsregeln des Betriebs mit dem Ansprechpartner vor Ort klären.", "Clarify the company's safety rules with the contact person on site.")]),
    t$("Akkus, Speicherkarten, Ansteckmikrofone und Stativ prüfen; Material noch am Drehtag doppelt sichern.", "Check batteries, memory cards, lavalier mics and tripod; back up footage twice on the shoot day."),
    t$("Untertitel einplanen: die meisten Reels werden ohne Ton geschaut.", "Plan subtitles: most reels are watched without sound."),
  ];
  const nextSteps = [
    ...(i.latitude !== undefined ? [t$(`Wetter und Schutzgebiete: shoot-location-check ab ${addDays(i.shoot_date, -9)} abrufen (Vorhersage höchstens 10 Tage).`, `Weather and protected areas: call shoot-location-check from ${addDays(i.shoot_date, -9)} (forecast at most 10 days ahead, Germany only).`)] : []),
    t$("Vollständige Shotlisten und Hook-Alternativen: video-recipes mit der recipe_id eines Reels.", "Full shot lists and hook alternatives: video-recipes with a reel's recipe_id."),
    t$("Veröffentlichung nach der Abgabe verteilen: Termine als posts an content-plan-shift geben oder content-month-plan nutzen.", "Spread publishing after delivery: send dates as posts to content-plan-shift or use content-month-plan."),
  ];

  const planId = createHash("sha256").update(JSON.stringify({ i, today })).digest("hex").slice(0, 12);
  const reels = day.ordered.map(r => { const row = day.rows.find(x => x.reel === r.key)!; return { ...r, slot: { start: row.start, end: row.end } }; });
  return {
    language: lang, plan_id: planId, today,
    project: { goal: GOAL_ALIAS[i.goal] ?? i.goal, industry: i.industry ?? null, trade_matched: tt?.label ?? null, job: ctx.job, town: i.town ?? null, shoot_date: i.shoot_date, window: { start: i.day_start, end: i.day_end }, deliver_by: i.deliver_by },
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

type Milestone = { step: string; label: string; start: string; end: string };
function ics(planId: string, today: string, i: Input, rows: Row[], end: string, milestones: Milestone[]): string {
  const t$ = (de: string, en: string) => tr(i.language, de, en);
  const day = (d: string) => d.replace(/-/g, ""), time = (d: string, t: string) => `${day(d)}T${t.replace(":", "")}00`, stamp = `${day(today)}T000000Z`;
  const events = [
    ["BEGIN:VEVENT", `UID:${planId}-shoot@agent.chiemgaufilms.com`, `DTSTAMP:${stamp}`, `DTSTART:${time(i.shoot_date, i.day_start)}`, `DTEND:${time(toMin(end) <= toMin(i.day_start) ? addDays(i.shoot_date, 1) : i.shoot_date, end)}`,
      `SUMMARY:${icsEscape(`${t$("Drehtag", "Shoot day")}${i.town ? ` ${i.town}` : ""}: ${rows.filter(r => r.kind === "shoot").length} Reels`)}`,
      `DESCRIPTION:${icsEscape(rows.map(r => `${r.start}–${r.end} ${r.label}`).join("\n"))}`, `CATEGORIES:${t$("Dreh", "Shoot")}`, "END:VEVENT"],
    ...milestones.map(m => ["BEGIN:VEVENT", `UID:${planId}-${m.step}@agent.chiemgaufilms.com`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${day(m.start)}`,
      `DTEND;VALUE=DATE:${day(addDays(m.end, 1))}`, `SUMMARY:${icsEscape(m.label)}`, `CATEGORIES:${t$("Postproduktion", "Post-production")}`, "END:VEVENT"]),
    ["BEGIN:VEVENT", `UID:${planId}-delivery@agent.chiemgaufilms.com`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${day(i.deliver_by)}`,
      `DTEND;VALUE=DATE:${day(addDays(i.deliver_by, 1))}`, `SUMMARY:${t$("Abgabe an den Kunden", "Delivery to the customer")}`, `CATEGORIES:${t$("Abgabe", "Delivery")}`, "END:VEVENT"],
  ];
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Chiemgau Films Agent Data API//Video Project Plan//DE", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", ...events.flat(), "END:VCALENDAR"].map(icsFold).join("\r\n") + "\r\n";
}

const exampleInput = { goal: "recruiting", industry: "Metallbau", town: "Chieming", shoot_date: "2026-11-20", deliver_by: "2026-12-23", reel_count_max: 10, latitude: 47.89, longitude: 12.54, today: "2026-10-24" };
const example: Input = inputSchema.parse(exampleInput);
export const videoProjectPlan: ServiceDefinition<Input, ReturnType<typeof plan>> = {
  id: cfg.id, name: cfg.name, route: cfg.route, priceUsdc: cfg.priceUsdc, enabled: cfg.enabled,
  cacheTtlSeconds: cfg.cacheTtlSeconds, limits: { maxInputs: cfg.maxInputs, maxResults: cfg.maxResults },
  upstream: { endpoint: cfg.dataforseoEndpoint, maxCostUsd: cfg.maxUpstreamCostUsd },
  summary: "One video job in one call: reel ideas for goal, trade and town, one shoot day in your time window, call sheet, sun times, post-production to delivery. DE/EN.",
  notice: "Rule-based, German or English (language), no AI model, stateless. Send roles, areas and the company's town only, no personal names or private addresses. Ideas are suggestions; durations are typical values you can override per reel. Nothing is written to any calendar.",
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
