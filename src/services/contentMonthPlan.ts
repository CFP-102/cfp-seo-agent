import { createHash } from "node:crypto";
import { z } from "zod";
import { PLAN_LIMITS, serviceConfig } from "../config/services.js";
import { CHAIN, MIN_GAP, labelOf, validateDates, type Step } from "./contentPhases.js";
import { languageInput, tr, type Lang } from "./i18n.js";
import { HOLIDAY_COVERAGE, holidayRegionInput, holidaysBetween } from "./holidays.js";
import { WEEKDAY_NAMES, addDays, berlinToday, diffDays, isWeekend, isoDate, weekday } from "./dates.js";
import { block, chunks, fits, hhmm, icsEscape, icsFold, norm, order, timeline, toMin, type Block, type Rules } from "./shootPlan.js";
import { recipeDataset, recipesIn, type Recipe } from "./videoRecipes.js";
import { compactExample } from "./exampleCompact.js";
import type { ServiceDefinition } from "./types.js";

/**
 * Content month plan: topics, publish dates, linked production dates (concept -> shoot -> edit -> review -> publish) and
 * bundled shoot days for a period. Rule-based port of the monthly planner of the operator's Content Kalender 2.0: no AI
 * model, stateless (existing dates are sent in, nothing is stored). The output feeds content-plan-shift.
 */
const cfg = serviceConfig("content-month-plan");
const categoryIds = recipeDataset.categories.map(c => c.id) as [string, ...string[]];
const count = z.number().int().min(0).max(PLAN_LIMITS.planPosts).optional();
const mixCounts = z.strictObject(Object.fromEntries(categoryIds.map(id => [id, count])) as Record<string, typeof count>);
const dayEnum = z.enum(WEEKDAY_NAMES);
const inputSchema = z.strictObject({
  from: isoDate,
  to: isoDate.describe("At most 62 days after from."),
  today: isoDate.optional(),
  posts_per_week: z.number().int().min(1).max(7).default(3),
  categories: z.array(z.enum(categoryIds)).min(1).max(7).default(["produkt", "mitarbeiter", "bts"]),
  mix_counts: mixCounts.optional().describe("Posts per category; overrides posts_per_week and categories."),
  media_type: z.enum(["reel", "video", "post", "story", "carousel"]).optional(),
  publish_weekdays: z.array(dayEnum).min(1).max(7).default(["mon", "wed", "fri"]),
  production_weekdays: z.array(dayEnum).min(1).max(5).default(["tue", "thu"]),
  phase_offsets: z.strictObject({
    concept: z.number().int().min(0).max(60).default(7), shoot: z.number().int().min(0).max(60).default(4),
    edit: z.number().int().min(0).max(60).default(2), review: z.number().int().min(0).max(60).default(1),
  }).default({ concept: 7, shoot: 4, edit: 2, review: 1 }).describe("Days before publish."),
  min_shoot_lead_days: z.number().int().min(0).max(14).default(3),
  avoid_weekends: z.boolean().default(true),
  start_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default("09:00"),
  max_shoots_per_day: z.number().int().min(1).max(6).default(3),
  max_day_minutes: z.number().int().min(240).max(720).default(480),
  break_minutes: z.number().int().min(0).max(60).default(15),
  lunch_minutes: z.number().int().min(0).max(90).default(45),
  existing_publish_dates: z.array(isoDate).max(PLAN_LIMITS.existingDates).default([]).describe("Publish dates already taken."),
  existing_shoot_dates: z.array(isoDate).max(PLAN_LIMITS.existingDates).default([]).describe("Shoot days already booked."),
  seed: z.number().int().min(0).max(99).default(0),
  language: languageInput,
  holiday_region: holidayRegionInput("none"),
}).refine(d => d.to >= d.from, { message: "to must not be before from", path: ["to"] })
  .refine(d => diffDays(d.from, d.to) <= PLAN_LIMITS.planSpanDays, { message: `The period may span at most ${PLAN_LIMITS.planSpanDays} days`, path: ["to"] })
  .refine(d => { if (!d.mix_counts) return true; const n = Object.values(d.mix_counts).reduce<number>((a, b) => a + (b ?? 0), 0); return n >= 1 && n <= PLAN_LIMITS.planPosts; }, { message: `mix_counts must add up to 1-${PLAN_LIMITS.planPosts} posts`, path: ["mix_counts"] });
type Input = z.output<typeof inputSchema>;

function pickIdea(recipe: Recipe, used: Set<string>, n: number): string {
  const ideas = recipe.ideas.length ? recipe.ideas : [recipe.title];
  for (let i = 0; i < ideas.length; i++) { const cand = ideas[(i + n) % ideas.length]!; if (!used.has(norm(cand))) { used.add(norm(cand)); return cand; } }
  for (let k = 2; k < 99; k++) { const c = `${recipe.title} #${k}`; if (!used.has(norm(c))) { used.add(norm(c)); return c; } }
  return recipe.title;
}

export function plan(i: Input) {
  const lang = i.language, t$ = (de: string, en: string) => tr(lang, de, en), set = recipesIn(lang);
  const today = i.today ?? berlinToday();
  const warnings: string[] = [];
  const pubDays = i.publish_weekdays.map(d => WEEKDAY_NAMES.indexOf(d)), prodDays = i.production_weekdays.map(d => WEEKDAY_NAMES.indexOf(d));
  const rules: Rules = { start_time: i.start_time, max_shoots_per_day: i.max_shoots_per_day, max_day_minutes: i.max_day_minutes, break_minutes: i.break_minutes, lunch_minutes: i.lunch_minutes };
  const off = i.phase_offsets;
  const from = i.from < addDays(today, 1) ? addDays(today, 1) : i.from;
  const earliestPublish = addDays(today, 2 + i.min_shoot_lead_days + 2); // preparation + shoot + edit
  const used = new Set(i.existing_publish_dates);

  // Public holidays of the chosen region: never used for publishing, shoots or preparation steps.
  const hol = holidaysBetween(i.holiday_region, today, i.to, lang);
  const isHoliday = (d: string) => hol.has(d);

  // 1) publish dates
  const slots: string[] = [];
  for (let d = from; d <= i.to; d = addDays(d, 1)) if (pubDays.includes(weekday(d)) && d >= earliestPublish && !isHoliday(d)) slots.push(d);
  const weeks = Math.max(1, Math.round((diffDays(from, i.to) + 1) / 7));
  const counts = i.mix_counts ? Object.entries(i.mix_counts).filter((e): e is [string, number] => (e[1] ?? 0) > 0) : null;
  let total = counts ? counts.reduce((a, [, n]) => a + n, 0) : Math.round(i.posts_per_week * weeks);
  if (total > PLAN_LIMITS.planPosts) { warnings.push(t$(`Es werden höchstens ${PLAN_LIMITS.planPosts} Beiträge je Plan geplant.`, `At most ${PLAN_LIMITS.planPosts} posts are planned per plan.`)); total = PLAN_LIMITS.planPosts; }
  let free = slots.filter(d => !used.has(d));
  if (free.length < total) {
    for (let d = from; d <= i.to && free.length < total; d = addDays(d, 1)) { if (d < earliestPublish || isWeekend(d) || isHoliday(d) || used.has(d) || free.includes(d)) continue; free.push(d); }
    free.sort();
  }
  if (free.length < total) {
    const usedSlots = slots.filter(d => used.has(d));
    if (free.length + usedSlots.length < total) warnings.push(t$(`Im Zeitraum gibt es nur ${free.length + usedSlots.length} passende Veröffentlichungstage – geplant werden ${free.length + usedSlots.length} Beiträge. Frühestmöglicher Veröffentlichungstag: ${earliestPublish}.`, `The period has only ${free.length + usedSlots.length} suitable publish days, so ${free.length + usedSlots.length} posts are planned. Earliest possible publish day: ${earliestPublish}.`));
    total = Math.min(total, free.length + usedSlots.length); free = free.concat(usedSlots);
  }
  const chosen: string[] = [];
  if (total > 0) {
    const pool = free.slice().sort(), step = pool.length / total;
    for (let n = 0; n < total; n++) chosen.push(pool[Math.min(pool.length - 1, Math.floor(n * step))]!);
  }
  const dates = [...new Set(chosen)].sort();
  if (dates.some(d => used.has(d))) warnings.push(t$("Einige Tage haben bereits Beiträge – dort entstehen Doppelungen. Die Termine lassen sich mit content-plan-shift ändern.", "Some days already have posts, so there are doubles. Move dates with content-plan-shift."));

  // 2) categories, evenly interleaved
  const cats = counts ? counts.map(([c]) => c) : [...new Set(i.categories)];
  const quota: Record<string, number> = {};
  if (counts) for (const [c, n] of counts) quota[c] = n;
  else { let assigned = 0; for (const c of cats) { quota[c] = Math.floor(dates.length / cats.length); assigned += quota[c]!; } for (let r = 0; assigned < dates.length; r++, assigned++) quota[cats[r % cats.length]!]!++; }
  const sequence: string[] = [];
  while (sequence.length < dates.length) {
    let progressed = false;
    for (const c of cats) if ((quota[c] ?? 0) > 0 && sequence.length < dates.length) { sequence.push(c); quota[c]!--; progressed = true; }
    if (!progressed) break;
  }

  // 3) recipes and concrete topics (no repeats inside the plan)
  const byCat = new Map<string, Recipe[]>();
  for (const r of set.recipes) byCat.set(r.category, [...(byCat.get(r.category) ?? []), r]);
  const cursor = new Map<string, number>(); const usedTitles = new Set<string>();
  const items = dates.map((date, idx) => {
    const category = sequence[idx] ?? cats[idx % cats.length]!;
    const list = byCat.get(category) ?? set.recipes;
    const k = cursor.has(category) ? cursor.get(category)! + 1 : i.seed; cursor.set(category, k);
    const recipe = list[k % list.length]!;
    const title = pickIdea(recipe, usedTitles, k + idx);
    const media_type = i.media_type ?? recipe.mediaType;
    const b: Block = block(idx, { title, recipe_id: recipe.id, media_type, location: recipe.locationHint }, lang);
    return { key: `p${idx + 1}`, date, category, recipe, title, media_type, b, shoot_day: null as string | null, phases: null as Partial<Record<Step, string>> | null };
  });

  // 4) bundle shoot days (material should not lie around longer than 4 weeks), then linked dates
  const busy = new Set(i.existing_shoot_dates);
  const apart = (d: string) => !busy.has(addDays(d, -1)) && !busy.has(addDays(d, 1));
  const floor = addDays(today, 2);
  const shootDateFor = (latest: string): string | null => {
    let d: string;
    for (d = latest; d >= floor; d = addDays(d, -1)) if (!busy.has(d) && !isHoliday(d) && prodDays.includes(weekday(d)) && apart(d)) return d;
    for (d = latest; d >= floor; d = addDays(d, -1)) if (!busy.has(d) && !isHoliday(d) && prodDays.includes(weekday(d))) return d;
    for (d = latest; d >= floor; d = addDays(d, -1)) if (!busy.has(d) && !isHoliday(d) && !isWeekend(d)) return d;
    return latest >= floor ? latest : null;
  };
  const windows: (typeof items)[] = []; let current: typeof items | null = null;
  for (const it of items) { if (!current || diffDays(current[0]!.date, it.date) > 28) { current = []; windows.push(current); } current.push(it); }
  const days: { date: string | null; items: typeof items }[] = [];
  for (const w of windows) {
    let n = w.length;
    for (let c = 1; c <= w.length; c++) if (chunks(w, c).every(chunk => fits(chunk.map(x => x.b), rules))) { n = c; break; }
    for (const chunk of chunks(w, n)) {
      const latest = chunk.reduce((a, it) => { const l = addDays(it.date, -i.min_shoot_lead_days); return l < a ? l : a; }, "9999-12-31");
      const date = shootDateFor(latest);
      if (date) busy.add(date);
      days.push({ date, items: chunk });
    }
  }
  days.sort((a, b) => ((a.date ?? "9999") < (b.date ?? "9999") ? -1 : 1));
  const conflicts: { level: "error" | "warn"; post_key: string; steps: Step[]; message: string }[] = [];
  const blocked = (x: string) => (i.avoid_weekends && isWeekend(x)) || isHoliday(x);
  const wk = (d: string, lowest: string, allowSame: boolean) => { let x = d; while (blocked(x) && (allowSame ? addDays(x, -1) >= lowest : addDays(x, -1) > lowest)) x = addDays(x, -1); return x; };
  days.forEach((day, n) => {
    for (const it of day.items) {
      it.shoot_day = `d${n + 1}`;
      const sd = day.date;
      if (!sd) {
        conflicts.push({ level: "error", post_key: it.key, steps: ["shoot", "publish"], message: `"${it.title}": ${t$("kein Drehtermin vor der Veröffentlichung möglich.", "no shoot date possible before publishing.")}` });
        it.phases = { publish: it.date }; continue;
      }
      let concept = wk(addDays(sd, -Math.max(0, off.concept - off.shoot)), today, true); if (concept < today) concept = today;
      let edit = wk(addDays(it.date, -off.edit), sd, false); if (edit <= sd) edit = addDays(sd, 1);
      let review = wk(addDays(it.date, -off.review), edit, true); if (review < edit) review = edit; if (review > it.date) review = it.date;
      it.phases = { concept, shoot: sd, edit, review, publish: it.date };
      for (const c of validateDates(it.phases, lang)) conflicts.push({ level: c.level, post_key: it.key, steps: c.steps, message: `"${it.title}": ${c.message}` });
    }
  });

  // 5) output
  const startMin = toMin(i.start_time);
  const keyByIndex = new Map(items.map(x => [x.b.index, x.key]));
  const shootDays = days.map((day, n) => {
    const ordered = order(day.items.map(x => x.b)); const tl = timeline(ordered, startMin, rules, lang);
    return { key: `d${n + 1}`, date: day.date, post_keys: day.items.map(x => x.key), shoots: day.items.length, total_minutes: tl.total, start: hhmm(startMin), end: hhmm(tl.end), schedule: tl.rows.map(r => ({ ...r, shoot_index: r.shoot_index === null ? null : (keyByIndex.get(r.shoot_index) ?? null) })) };
  });
  const posts = items.map(it => {
    const ph = it.phases ?? { publish: it.date };
    return {
      key: it.key, title: it.title, category: it.category, recipe_id: it.recipe.id, media_type: it.media_type, location: it.b.location, slot_minutes: it.b.minutes, recording_minutes: it.b.recording_minutes,
      publish: it.date, concept: ph.concept ?? null, shoot: ph.shoot ?? null, edit: ph.edit ?? null, review: ph.review ?? null, shoot_day: it.shoot_day,
      linked_dates: CHAIN.map((step, n) => ({ step, label: labelOf(lang, step), date: ph[step] ?? null, depends_on: n ? CHAIN[n - 1]! : null, min_days_after_previous: n ? MIN_GAP[CHAIN[n - 1]!] : null })),
    };
  });
  const planId = createHash("sha256").update(JSON.stringify({ i, today })).digest("hex").slice(0, 12);
  const potential = items.reduce((n, it) => n + it.recipe.variants.reduce((a, v) => a + v.count, 0), 0);
  return {
    language: lang, plan_id: planId, period: { from: i.from, to: i.to, planning_start: from }, today,
    summary: { posts: items.length, shoot_days: shootDays.length, shoot_days_total_minutes: shootDays.reduce((n, d) => n + d.total_minutes, 0), recording_minutes_total: items.reduce((n, it) => n + it.b.recording_minutes, 0), potential_extra_pieces: potential, first_shoot: shootDays.find(d => d.date)?.date ?? null },
    posts, shoot_days: shootDays, conflicts, warnings,
    posts_for_reschedule: posts.map(p => ({ key: p.key, title: p.title, publish: p.publish, ...(p.concept ? { concept: p.concept } : {}), ...(p.shoot ? { shoot: p.shoot } : {}), ...(p.edit ? { edit: p.edit } : {}), ...(p.review ? { review: p.review } : {}), ...(p.shoot_day ? { shoot_group: p.shoot_day } : {}) })),
    next_step: "Send posts_for_reschedule to content-plan-shift together with one move to shift a date; the linked dates and shared shoot days follow.",
    holiday_region: i.holiday_region,
    holidays: [...hol].filter(([d]) => d >= from).map(([date, name]) => ({ date, name })),
    calendar_file_ics: ics(planId, today, posts, shootDays, lang),
    coverage: (i.holiday_region === "none" ? "No public holidays checked (set holiday_region). " : `${HOLIDAY_COVERAGE.en} `) + "Rule-based plan from your settings and the built-in recipes (video-recipes): topics are suggestions, not a strategy. No vacations, people or capacities are checked; existing_publish_dates and existing_shoot_dates are the only things it knows about your calendar. Calendar files are text you import yourself; nothing is written to any calendar.",
  };
}

interface IcsPost { key: string; title: string; media_type: string; linked_dates: { step: Step; date: string | null }[] }
interface IcsDay { key: string; date: string | null; post_keys: string[]; shoots: number; start: string; end: string; schedule: { start: string; end: string; label: string }[] }
function ics(planId: string, today: string, posts: IcsPost[], shootDays: IcsDay[], lang: Lang): string {
  const t$ = (de: string, en: string) => tr(lang, de, en), L = (s: Step) => labelOf(lang, s);
  const stamp = `${today.replace(/-/g, "")}T000000Z`, day = (d: string) => d.replace(/-/g, "");
  const events: string[][] = [];
  for (const p of posts) {
    const publishUid = `${planId}-${p.key}-publish@agent.chiemgaufilms.com`;
    for (const step of CHAIN) {
      const date = p.linked_dates.find(l => l.step === step)?.date;
      if (!date || step === "shoot") continue; // the shoot appears once per shoot day below
      events.push([
        "BEGIN:VEVENT", `UID:${step === "publish" ? publishUid : `${planId}-${p.key}-${step}@agent.chiemgaufilms.com`}`, `DTSTAMP:${stamp}`,
        `DTSTART;VALUE=DATE:${day(date)}`, `DTEND;VALUE=DATE:${day(addDays(date, 1))}`, `SUMMARY:${icsEscape(`${L(step)} · ${p.title}`)}`,
        `DESCRIPTION:${icsEscape(`${t$("Kette", "Chain")}: ${CHAIN.map(L).join(" → ")}. Format: ${p.media_type}.`)}`, `CATEGORIES:${L(step)}`,
        ...(step === "publish" ? [] : [`RELATED-TO;RELTYPE=PARENT:${publishUid}`]), "END:VEVENT",
      ]);
    }
  }
  for (const d of shootDays) {
    if (!d.date) continue;
    const titles = d.post_keys.map(k => posts.find(p => p.key === k)!.title);
    const endMin = toMin(d.end), startMin = toMin(d.start);
    const stampTime = (date: string, m: number) => `${day(date)}T${hhmm(m).replace(":", "")}00`;
    events.push([
      "BEGIN:VEVENT", `UID:${planId}-${d.key}-shoot@agent.chiemgaufilms.com`, `DTSTAMP:${stamp}`, `DTSTART:${stampTime(d.date, startMin)}`,
      `DTEND:${stampTime(endMin <= startMin ? addDays(d.date, 1) : d.date, endMin)}`, `SUMMARY:${icsEscape(`${t$("Drehtag", "Shoot day")} ${d.key}: ${d.shoots} ${d.shoots === 1 ? t$("Beitrag", "post") : t$("Beiträge", "posts")}`)}`,
      `DESCRIPTION:${icsEscape(titles.join("\n") + "\n\n" + d.schedule.map(r => `${r.start}–${r.end} ${r.label}`).join("\n"))}`, `CATEGORIES:${L("shoot")}`, "END:VEVENT",
    ]);
  }
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Chiemgau Films Agent Data API//Content Month Plan//DE", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", ...events.flat(), "END:VCALENDAR"].map(icsFold).join("\r\n") + "\r\n";
}

/** Documented example without defaults (it travels in the 402 header); the output example is computed from the fully defaulted form. */
const exampleInput = { from: "2026-11-02", to: "2026-11-27", today: "2026-10-24", mix_counts: { produkt: 2, mitarbeiter: 2, bts: 2 } };
const example: Input = inputSchema.parse(exampleInput);
export const contentMonthPlan: ServiceDefinition<Input, ReturnType<typeof plan>> = {
  id: cfg.id, name: cfg.name, route: cfg.route, priceUsdc: cfg.priceUsdc, enabled: cfg.enabled,
  cacheTtlSeconds: cfg.cacheTtlSeconds, limits: { maxInputs: cfg.maxInputs, maxResults: cfg.maxResults },
  upstream: { endpoint: cfg.dataforseoEndpoint, maxCostUsd: cfg.maxUpstreamCostUsd },
  summary: "Plan a content month for an agency: up to 30 posts with topics, publish dates and linked production dates, bundled shoot days, holidays per region, conflicts and an .ics file. EN/DE.",
  notice: "Rule-based, German or English (language), no AI model, stateless. Send periods, counts, weekdays and your already booked dates only, no personal data. Topics are suggestions from built-in recipes, not a content strategy. Nothing is written to any calendar; the .ics text is yours to import.",
  inputSchema, estimateCostUsd: () => 0,
  validateInput: i => { const earliest = addDays(i.today ?? berlinToday(), 2 + i.min_shoot_lead_days + 2); return i.to < earliest ? `The period ends before the first possible publish date (${earliest}): preparation, shoot and edit need time. Choose a later "to".` : null; },
  buildRequest: i => [i], mapResult: (_task, i) => plan(i), executeLocal: plan,
  example: exampleInput as unknown as Input, outputExample: compactExample(plan(example), 1, 18),
};
