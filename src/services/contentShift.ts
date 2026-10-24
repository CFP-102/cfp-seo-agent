import { z } from "zod";
import { PLAN_LIMITS, serviceConfig } from "../config/services.js";
import { CHAIN, LABEL_DE, STEPS, propagate, validateDates, type Dates, type Step } from "./contentPhases.js";
import { plain } from "./common.js";
import { addDays, diffDays, isoDate } from "./dates.js";
import { compactExample } from "./exampleCompact.js";
import type { ServiceDefinition } from "./types.js";

/**
 * Re-schedule linked content dates. Move one step of one post and every dependent step follows (concept -> shoot -> edit ->
 * review -> publish), shared shoot days move together, completed steps never move. Stateless: you send the posts, you get
 * the new dates and a change list back; nothing is stored. Rules ported from the operator's Content Kalender 2.0.
 */
const cfg = serviceConfig("content-plan-shift");
const stepEnum = z.enum(STEPS);
const postSchema = z.strictObject({
  key: z.string().min(1).max(40).regex(/^[A-Za-z0-9_-]+$/, "Keys may contain letters, digits, - and _"),
  title: plain(PLAN_LIMITS.titleChars).optional().describe("Optional label echoed in messages. No personal data."),
  publish: isoDate, concept: isoDate.optional(), shoot: isoDate.optional(), edit: isoDate.optional(), review: isoDate.optional(),
  done: z.array(stepEnum).max(4).optional().describe("Steps that are already finished; they are never moved."),
  shoot_group: plain(40).optional().describe("Posts with the same value share one shoot day and move together."),
});
const inputSchema = z.strictObject({
  posts: z.array(postSchema).min(1).max(cfg.maxInputs),
  move: z.strictObject({
    post_key: z.string().min(1).max(40), step: z.enum(CHAIN), new_date: isoDate,
    publish_mode: z.enum(["shift_all", "only_publish"]).default("shift_all").describe("Publish moves: also shift the unfinished steps by the same number of days, or only the publish date."),
    shoot_mode: z.enum(["group", "detach"]).default("group").describe("Shoot step of a grouped post: move the whole shoot day, or detach this post from the group."),
  }),
});
type Input = z.output<typeof inputSchema>;
type Post = Input["posts"][number];

const datesOf = (p: Post): Dates => { const d: Dates = { publish: p.publish }; for (const k of STEPS) if (p[k]) d[k] = p[k]; return d; };
const label = (p: Post) => (p.title ? `„${p.title}"` : `„${p.key}"`);
interface Change { post_key: string; step: Step; from: string | null; to: string; created: boolean }

export function shift(i: Input) {
  const posts = i.posts.map(p => ({ ...p }));
  const post = posts.find(p => p.key === i.move.post_key)!;
  const changes: Change[] = [], blocked: { post_key: string; step: Step }[] = [];
  const conflicts: { level: "error" | "warn"; post_key: string | null; steps: Step[]; message: string }[] = [];
  let groupChange: { group: string; from: string | null; to: string; post_keys: string[] } | null = null;
  let detached = false;

  const collect = (p: Post, before: Dates, after: Dates) => {
    for (const k of CHAIN) if (after[k] && after[k] !== before[k]) changes.push({ post_key: p.key, step: k, from: before[k] ?? null, to: after[k]!, created: !before[k] });
  };
  const check = (p: Post, dates: Dates) => { for (const c of validateDates(dates)) conflicts.push({ level: c.level, post_key: p.key, steps: c.steps, message: `${label(p)}: ${c.message}` }); };
  const apply = (p: Post, after: Dates) => { for (const k of CHAIN) if (after[k]) (p as Record<string, unknown>)[k] = after[k]; };
  const members = post.shoot_group ? posts.filter(p => p.shoot_group === post.shoot_group) : [];

  if (i.move.step === "shoot" && post.shoot_group && i.move.shoot_mode === "group") {
    groupChange = { group: post.shoot_group, from: post.shoot ?? null, to: i.move.new_date, post_keys: members.map(m => m.key) };
    for (const m of members) {
      const done = new Set<Step>(m.done ?? []);
      if (done.has("shoot")) { blocked.push({ post_key: m.key, step: "shoot" }); conflicts.push({ level: "warn", post_key: m.key, steps: ["shoot"], message: `${label(m)}: Dreh bereits erledigt – bleibt unverändert.` }); continue; }
      const before = datesOf(m), after: Dates = { ...before, shoot: i.move.new_date }, stuck: Step[] = [];
      propagate(after, done, "shoot", stuck);
      for (const k of stuck) blocked.push({ post_key: m.key, step: k });
      collect(m, before, after); check(m, after); apply(m, after);
    }
  } else {
    if (i.move.step === "shoot" && post.shoot_group) { detached = true; }
    const grouped = !!post.shoot_group && !detached;
    const before = datesOf(post), after: Dates = { ...before }, done = new Set<Step>(post.done ?? []), stuck: Step[] = [];
    if (i.move.step === "publish") {
      const delta = diffDays(post.publish, i.move.new_date);
      after.publish = i.move.new_date;
      if (i.move.publish_mode === "shift_all") {
        for (const k of STEPS) {
          if (!after[k] || done.has(k)) continue;
          if (grouped && (k === "shoot" || k === "concept")) continue; // bound to the shared shoot day
          after[k] = addDays(after[k]!, delta);
        }
      }
    } else {
      after[i.move.step] = i.move.new_date;
      propagate(after, done, i.move.step, stuck);
    }
    for (const k of stuck) blocked.push({ post_key: post.key, step: k });
    collect(post, before, after); check(post, after);
    if (grouped && i.move.step === "publish" && post.shoot && i.move.new_date <= post.shoot) {
      conflicts.push({ level: "error", post_key: post.key, steps: ["shoot", "publish"], message: `${label(post)}: Die Veröffentlichung läge vor dem gemeinsamen Drehtag (${post.shoot}).` });
    }
    apply(post, after);
    if (detached) delete post.shoot_group;
  }
  const seen = new Set<string>();
  for (const b of blocked) {
    const k = `${b.post_key}/${b.step}`; if (seen.has(k) || (b.step === "shoot" && conflicts.some(c => c.post_key === b.post_key && c.message.includes("Dreh bereits erledigt")))) continue;
    seen.add(k);
    const p = posts.find(x => x.key === b.post_key)!;
    conflicts.push({ level: "warn", post_key: b.post_key, steps: [b.step], message: `${label(p)}: Abgeschlossene Phase „${LABEL_DE[b.step]}" wird nicht automatisch verschoben.` });
  }
  return {
    language: "de", move: { post_key: i.move.post_key, step: i.move.step, new_date: i.move.new_date },
    changes, blocked, conflicts, group_change: groupChange, detached_from_group: detached,
    needs_confirmation: changes.length > 1 || conflicts.length > 0 || blocked.length > 0 || groupChange !== null,
    summary: { posts_changed: new Set(changes.map(c => c.post_key)).size, dates_changed: changes.length, errors: conflicts.filter(c => c.level === "error").length, warnings: conflicts.filter(c => c.level === "warn").length },
    posts,
    coverage: "Stateless date arithmetic on the posts you send. Weekends, holidays, people and shoot-day capacity are not checked here; run shoot-day-plan for a shoot day. Nothing is stored or written to any calendar.",
  };
}

const exampleInput = {
  posts: [
    { key: "p1", title: "Produkt in 30 Sekunden", concept: "2026-11-03", shoot: "2026-11-06", edit: "2026-11-11", review: "2026-11-12", publish: "2026-11-13", shoot_group: "d1" },
    { key: "p2", title: "Mitarbeiter stellt sich vor", concept: "2026-11-03", shoot: "2026-11-06", edit: "2026-11-16", review: "2026-11-17", publish: "2026-11-18", shoot_group: "d1" },
  ],
  move: { post_key: "p1", step: "shoot", new_date: "2026-11-10" },
};
const example: Input = inputSchema.parse(exampleInput);
export const contentPlanShift: ServiceDefinition<Input, ReturnType<typeof shift>> = {
  id: cfg.id, name: cfg.name, route: cfg.route, priceUsdc: cfg.priceUsdc, enabled: cfg.enabled,
  cacheTtlSeconds: cfg.cacheTtlSeconds, limits: { maxInputs: cfg.maxInputs, maxResults: cfg.maxResults },
  upstream: { endpoint: cfg.dataforseoEndpoint, maxCostUsd: cfg.maxUpstreamCostUsd },
  summary: "Move one date in a content calendar and let the linked dates follow: concept, shoot, edit, review and publish stay in order, a shared shoot day moves all its posts together, finished steps never move. Returns the change list, conflicts, blocked steps, a confirmation flag and the updated posts. Stateless: you send up to 40 posts, nothing is stored.",
  notice: "Pure date arithmetic, German messages, no AI model. Send keys, optional short titles and dates only, no personal data. A confirmation flag means you should review the change list before you apply it to your own calendar; nothing is written anywhere by this service.",
  inputSchema, estimateCostUsd: () => 0,
  validateInput: i => {
    const keys = i.posts.map(p => p.key);
    if (new Set(keys).size !== keys.length) return "Post keys must be unique.";
    const post = i.posts.find(p => p.key === i.move.post_key);
    if (!post) return `Unknown move.post_key "${i.move.post_key}".`;
    if (i.move.step !== "publish" && (post.done ?? []).includes(i.move.step)) return `Step "${i.move.step}" of this post is marked done and cannot be moved.`;
    return null;
  },
  buildRequest: i => [i], mapResult: (_task, i) => shift(i), executeLocal: shift,
  example: exampleInput as unknown as Input, outputExample: compactExample(shift(example), 1, 50),
};
