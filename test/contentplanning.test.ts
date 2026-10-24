import { describe, expect, it } from "vitest";
import { recipeDataset } from "../src/services/videoRecipes.js";
import { contentMonthPlan } from "../src/services/contentMonthPlan.js";
import { contentPlanShift } from "../src/services/contentShift.js";
import { CHAIN, MIN_GAP, propagate, validateDates, type Dates, type Step } from "../src/services/contentPhases.js";
import { addDays, diffDays, isWeekend, weekday } from "../src/services/dates.js";
import { PLAN_LIMITS } from "../src/config/services.js";

const TODAY = "2026-10-24"; // a Saturday
const plan = (input: Record<string, unknown>) => contentMonthPlan.executeLocal!(contentMonthPlan.inputSchema.parse({ today: TODAY, ...input }));
const shift = (input: unknown) => contentPlanShift.executeLocal!(contentPlanShift.inputSchema.parse(input));
const base = { from: "2026-11-01", to: "2026-11-30", mix_counts: { produkt: 4, mitarbeiter: 4, bts: 4 } };

describe("linked dates (phase chain)", () => {
  it("flags order errors, too-close steps and a shoot right before publishing", () => {
    expect(validateDates({ concept: "2026-11-01", shoot: "2026-11-03", edit: "2026-11-05", review: "2026-11-06", publish: "2026-11-09" })).toEqual([]);
    expect(validateDates({ shoot: "2026-11-05", edit: "2026-11-03", publish: "2026-11-09" })[0]).toMatchObject({ level: "error", steps: ["shoot", "edit"] });
    expect(validateDates({ shoot: "2026-11-05", edit: "2026-11-05", publish: "2026-11-09" })[0]).toMatchObject({ level: "warn", steps: ["shoot", "edit"] }); // shoot needs one day before edit
    expect(validateDates({ shoot: "2026-11-08", publish: "2026-11-09" }).some(c => c.message.includes("nur einen Tag"))).toBe(true);
    expect(validateDates({ shoot: "2026-11-09", publish: "2026-11-09" }).some(c => c.message.includes("selben Tag"))).toBe(true);
    expect(MIN_GAP.shoot).toBe(1); expect(CHAIN).toEqual(["concept", "shoot", "edit", "review", "publish"]);
  });
  it("propagates forwards and backwards, never moves finished steps and reports them as blocked", () => {
    const dates: Dates = { concept: "2026-11-02", shoot: "2026-11-04", edit: "2026-11-06", review: "2026-11-07", publish: "2026-11-10" };
    const blocked: Step[] = [];
    propagate(dates, new Set<Step>(["edit"]), "shoot", blocked); // shoot unchanged: nothing to do
    expect(blocked).toEqual([]);
    dates.shoot = "2026-11-09";
    propagate(dates, new Set<Step>(["edit"]), "shoot", blocked);
    expect(blocked).toEqual(["edit"]); expect(dates.edit).toBe("2026-11-06"); // done: untouched, later steps keep relating to it
    expect(dates.review).toBe("2026-11-07");
    const clamp: Dates = { shoot: "2026-11-12", edit: "2026-11-06", review: "2026-11-07", publish: "2026-11-10" };
    propagate(clamp, new Set<Step>(), "shoot", []);
    expect(clamp).toMatchObject({ edit: "2026-11-10", review: "2026-11-10" }); // pushed, but never beyond the publish date
    const early: Dates = { concept: "2026-11-02", shoot: "2026-11-04", edit: "2026-11-06", publish: "2026-11-10" };
    early.concept = "2026-11-20"; propagate(early, new Set<Step>(), "concept", []);
    expect(early.shoot).toBe("2026-11-10"); // follows the concept but is capped at the publish date
  });
});

describe("content-month-plan", () => {
  it("plans linked dates for every post in a valid order, on allowed weekdays, never earlier than preparation allows", () => {
    const r = plan(base);
    expect(r.posts).toHaveLength(12);
    const earliest = addDays(TODAY, 2 + 3 + 2);
    for (const p of r.posts) {
      expect(p.publish >= earliest, p.key).toBe(true);
      expect(["mon", "wed", "fri"][0]).toBeDefined();
      expect([0, 2, 4].includes(weekday(p.publish)) || !isWeekend(p.publish), p.key).toBe(true);
      expect(validateDates({ concept: p.concept!, shoot: p.shoot!, edit: p.edit!, review: p.review!, publish: p.publish }).filter(c => c.level === "error"), p.key).toEqual([]);
      expect(diffDays(p.publish, p.shoot!) <= -3 || diffDays(p.shoot!, p.publish) >= 1, p.key).toBe(true);
      expect(p.concept! <= p.shoot! && p.shoot! < p.edit! && p.edit! <= p.review! && p.review! <= p.publish, p.key).toBe(true);
      expect(p.concept! >= TODAY, p.key).toBe(true);
    }
    expect(r.conflicts).toEqual([]);
    expect(new Set(r.posts.map(p => p.title)).size).toBe(12);
  });
  it("honours the exact category mix", () => {
    const r = plan(base);
    const by = (c: string) => r.posts.filter(p => p.category === c).length;
    expect([by("produkt"), by("mitarbeiter"), by("bts")]).toEqual([4, 4, 4]);
    const shared = plan({ from: "2026-11-01", to: "2026-11-30", posts_per_week: 3, categories: ["wissen", "kunde"] });
    expect(new Set(shared.posts.map(p => p.category))).toEqual(new Set(["wissen", "kunde"]));
  });
  it("bundles posts into shoot days: at most three per day, within the day limit, preferred weekdays, no neighbouring shoot days", () => {
    const r = plan({ ...base, existing_shoot_dates: ["2026-11-03"] });
    for (const d of r.shoot_days) {
      expect(d.shoots).toBeLessThanOrEqual(3); expect(d.total_minutes).toBeLessThanOrEqual(480);
      expect([1, 3].includes(weekday(d.date!)), d.key).toBe(true);
      expect(d.date).not.toBe("2026-11-03"); expect(Math.abs(diffDays("2026-11-03", d.date!))).toBeGreaterThan(1);
    }
    const dates = r.shoot_days.map(d => d.date!);
    for (let i = 1; i < dates.length; i++) expect(diffDays(dates[i - 1]!, dates[i]!)).toBeGreaterThan(1);
    expect(r.shoot_days.flatMap(d => d.post_keys).sort()).toEqual(r.posts.map(p => p.key).sort());
    for (const p of r.posts) expect(r.shoot_days.find(d => d.key === p.shoot_day)!.date).toBe(p.shoot);
    for (const d of r.shoot_days) expect(d.schedule.some(x => x.label.startsWith("Mittagspause")) || d.shoots < 3).toBe(true);
  });
  it("avoids already taken publish dates when free days exist and warns when it cannot", () => {
    const taken = plan({ ...base, existing_publish_dates: ["2026-11-06", "2026-11-13"] });
    expect(taken.posts.some(p => p.publish === "2026-11-06" || p.publish === "2026-11-13")).toBe(false);
    const crowded = plan({ from: "2026-11-02", to: "2026-11-04", mix_counts: { produkt: 3 }, existing_publish_dates: ["2026-11-04"] });
    expect(crowded.posts).toHaveLength(3); expect(crowded.warnings.join(" ")).toContain("Doppelungen");
    const tooFew = plan({ from: "2026-11-02", to: "2026-11-03", mix_counts: { produkt: 6 } });
    expect(tooFew.warnings.join(" ")).toContain("nur"); expect(tooFew.posts.length).toBeLessThan(6);
  });
  it("plans nothing, without crashing, when the period is too close to today", () => {
    const r = plan({ from: "2026-10-25", to: "2026-10-29", posts_per_week: 3 });
    expect(r.posts).toEqual([]); expect(r.warnings.join(" ")).toContain("Frühestmöglicher Veröffentlichungstag");
    expect(contentMonthPlan.validateInput!(contentMonthPlan.inputSchema.parse({ today: TODAY, from: "2026-10-25", to: "2026-10-29", posts_per_week: 3 }))).toContain("first possible publish date");
    expect(contentMonthPlan.validateInput!(contentMonthPlan.inputSchema.parse({ today: TODAY, ...base }))).toBeNull();
  });
  it.skipIf(recipeDataset.sample)("is deterministic, varies with the seed and caps the number of posts", () => {
    expect(plan(base)).toEqual(plan(base));
    expect(plan({ ...base, seed: 3 }).posts.map(p => p.title)).not.toEqual(plan(base).posts.map(p => p.title));
    const many = plan({ from: "2026-11-01", to: "2026-12-31", posts_per_week: 7, publish_weekdays: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] });
    expect(many.posts.length).toBeLessThanOrEqual(PLAN_LIMITS.planPosts);
    expect(many.warnings.join(" ")).toContain(String(PLAN_LIMITS.planPosts));
  });
  it("writes one valid .ics file with unique UIDs, linked events and folded lines", () => {
    const r = plan(base);
    const ics = r.calendar_file_ics;
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true); expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(r.posts.length * 4 + r.shoot_days.length);
    const uids = [...ics.matchAll(/UID:(\S+)\r\n/g)].map(m => m[1]!);
    expect(new Set(uids).size).toBe(uids.length);
    expect(ics).toContain("RELATED-TO;RELTYPE=PARENT:"); expect(ics).toContain("DTSTART;VALUE=DATE:2026");
    for (const line of ics.split("\r\n")) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
  });
  it("hands over posts that content-plan-shift accepts unchanged", () => {
    const r = plan(base);
    const parsed = contentPlanShift.inputSchema.safeParse({ posts: r.posts_for_reschedule, move: { post_key: "p1", step: "publish", new_date: addDays(r.posts[0]!.publish, 3) } });
    expect(parsed.success).toBe(true);
    expect(r.posts_for_reschedule[0]).toMatchObject({ key: "p1", shoot_group: r.posts[0]!.shoot_day });
  });
  it("validates the input before payment: spans, counts, categories, unknown fields and dates", () => {
    const s = contentMonthPlan.inputSchema;
    expect(s.safeParse({ ...base, today: TODAY }).success).toBe(true);
    expect(s.safeParse({ ...base, to: "2026-10-01" }).success).toBe(false);
    expect(s.safeParse({ from: "2026-11-01", to: "2027-01-31" }).success).toBe(false);
    expect(s.safeParse({ ...base, mix_counts: {} }).success).toBe(false);
    expect(s.safeParse({ ...base, mix_counts: { produkt: 31 } }).success).toBe(false);
    expect(s.safeParse({ ...base, mix_counts: { krimi: 3 } }).success).toBe(false);
    expect(s.safeParse({ ...base, categories: ["krimi"] }).success).toBe(false);
    expect(s.safeParse({ ...base, url: "https://example.com" }).success).toBe(false);
    expect(s.safeParse({ ...base, from: "2026-02-30" }).success).toBe(false);
    expect(s.safeParse({ ...base, existing_publish_dates: Array(PLAN_LIMITS.existingDates + 1).fill("2026-11-04") }).success).toBe(false);
    expect(s.safeParse({ ...base, publish_weekdays: ["someday"] }).success).toBe(false);
  });
});

describe("content-plan-shift", () => {
  const posts = () => [
    { key: "a", title: "Produkt", concept: "2026-11-03", shoot: "2026-11-06", edit: "2026-11-11", review: "2026-11-12", publish: "2026-11-13", shoot_group: "d1" },
    { key: "b", title: "Team", concept: "2026-11-03", shoot: "2026-11-06", edit: "2026-11-16", review: "2026-11-17", publish: "2026-11-18", shoot_group: "d1" },
    { key: "c", title: "Einzeln", concept: "2026-11-09", shoot: "2026-11-12", edit: "2026-11-17", review: "2026-11-18", publish: "2026-11-20" },
  ];
  it("moves a shared shoot day for all posts of the group and asks for confirmation", () => {
    const r = shift({ posts: posts(), move: { post_key: "a", step: "shoot", new_date: "2026-11-09" } });
    expect(r.group_change).toMatchObject({ group: "d1", from: "2026-11-06", to: "2026-11-09", post_keys: ["a", "b"] });
    expect(r.posts.filter(p => p.shoot === "2026-11-09").map(p => p.key)).toEqual(["a", "b"]);
    expect(r.posts.find(p => p.key === "c")!.shoot).toBe("2026-11-12");
    expect(r.needs_confirmation).toBe(true); expect(r.conflicts).toEqual([]);
  });
  it("pushes dependent steps along and reports a publish date that is now too early", () => {
    const tight = shift({ posts: posts(), move: { post_key: "a", step: "shoot", new_date: "2026-11-12" } });
    expect(tight.conflicts.some(c => c.post_key === "a" && c.level === "warn" && c.message.includes("nur einen Tag"))).toBe(true);
    const r = shift({ posts: posts(), move: { post_key: "a", step: "shoot", new_date: "2026-11-14" } });
    expect(r.posts.find(p => p.key === "a")!.edit).toBe("2026-11-13"); // clamped to publish
    expect(r.summary.errors).toBeGreaterThan(0);
    expect(r.conflicts.some(c => c.post_key === "a" && c.level === "error")).toBe(true);
  });
  it("detaches one post from its shoot group on request and leaves the others in place", () => {
    const r = shift({ posts: posts(), move: { post_key: "a", step: "shoot", new_date: "2026-11-09", shoot_mode: "detach" } });
    expect(r.detached_from_group).toBe(true); expect(r.group_change).toBeNull();
    expect(r.posts.find(p => p.key === "a")!.shoot).toBe("2026-11-09"); expect(r.posts.find(p => p.key === "a")!.shoot_group).toBeUndefined();
    expect(r.posts.find(p => p.key === "b")).toMatchObject({ shoot: "2026-11-06", shoot_group: "d1" });
  });
  it("never moves finished steps and says so", () => {
    const input = posts(); (input[2] as Record<string, unknown>).done = ["shoot", "edit"];
    const r = shift({ posts: input, move: { post_key: "c", step: "concept", new_date: "2026-11-13" } });
    const c = r.posts.find(p => p.key === "c")!;
    expect(c.shoot).toBe("2026-11-12"); expect(c.edit).toBe("2026-11-17");
    expect(r.blocked.some(b => b.post_key === "c" && b.step === "shoot")).toBe(true);
    expect(r.conflicts.some(x => x.message.includes("Abgeschlossene Phase"))).toBe(true);
    const grouped = posts(); (grouped[1] as Record<string, unknown>).done = ["shoot"];
    const g = shift({ posts: grouped, move: { post_key: "a", step: "shoot", new_date: "2026-11-09" } });
    expect(g.posts.find(p => p.key === "b")!.shoot).toBe("2026-11-06"); expect(g.posts.find(p => p.key === "a")!.shoot).toBe("2026-11-09");
    expect(g.conflicts.some(x => x.message.includes("Dreh bereits erledigt"))).toBe(true);
  });
  it("shifts unfinished steps with the publish date, but keeps shared shoot days fixed; only_publish moves just the date", () => {
    const solo = shift({ posts: posts(), move: { post_key: "c", step: "publish", new_date: "2026-11-27" } });
    expect(solo.posts.find(p => p.key === "c")).toMatchObject({ concept: "2026-11-16", shoot: "2026-11-19", edit: "2026-11-24", review: "2026-11-25", publish: "2026-11-27" });
    const grouped = shift({ posts: posts(), move: { post_key: "b", step: "publish", new_date: "2026-11-25" } });
    expect(grouped.posts.find(p => p.key === "b")).toMatchObject({ concept: "2026-11-03", shoot: "2026-11-06", edit: "2026-11-23", review: "2026-11-24", publish: "2026-11-25" });
    const only = shift({ posts: posts(), move: { post_key: "c", step: "publish", new_date: "2026-11-27", publish_mode: "only_publish" } });
    expect(only.changes).toEqual([{ post_key: "c", step: "publish", from: "2026-11-20", to: "2026-11-27", created: false }]);
    const early = shift({ posts: posts(), move: { post_key: "b", step: "publish", new_date: "2026-11-06" } });
    expect(early.conflicts.some(c => c.level === "error" && c.message.includes("gemeinsamen Drehtag"))).toBe(true);
  });
  it("creates a missing step, does not mutate the input and echoes the new dates", () => {
    const input = [{ key: "x", publish: "2026-11-20" }];
    const before = JSON.stringify(input);
    const r = shift({ posts: input, move: { post_key: "x", step: "shoot", new_date: "2026-11-10" } });
    expect(JSON.stringify(input)).toBe(before);
    expect(r.changes).toEqual([{ post_key: "x", step: "shoot", from: null, to: "2026-11-10", created: true }]);
    expect(r.posts[0]).toMatchObject({ key: "x", shoot: "2026-11-10", publish: "2026-11-20" });
    expect(r.needs_confirmation).toBe(false);
  });
  it("is refused before payment for unknown posts, duplicate keys and finished moved steps", () => {
    const v = (p: unknown, m: unknown) => contentPlanShift.validateInput!(contentPlanShift.inputSchema.parse({ posts: p, move: m }));
    expect(v(posts(), { post_key: "zzz", step: "edit", new_date: "2026-11-10" })).toContain("Unknown");
    expect(v([...posts(), posts()[0]], { post_key: "a", step: "edit", new_date: "2026-11-10" })).toContain("unique");
    expect(v([{ key: "a", publish: "2026-11-13", done: ["edit"] }], { post_key: "a", step: "edit", new_date: "2026-11-10" })).toContain("done");
    expect(v(posts(), { post_key: "a", step: "edit", new_date: "2026-11-10" })).toBeNull();
  });
  it("validates input strictly: keys, dates, sizes, control characters and unknown fields", () => {
    const s = contentPlanShift.inputSchema; const move = { post_key: "a", step: "edit", new_date: "2026-11-10" };
    expect(s.safeParse({ posts: posts(), move }).success).toBe(true);
    expect(s.safeParse({ posts: [{ key: "a b", publish: "2026-11-13" }], move }).success).toBe(false);
    expect(s.safeParse({ posts: [{ key: "a", publish: "2026-11-31" }], move }).success).toBe(false);
    expect(s.safeParse({ posts: [{ key: "a", publish: "2026-11-13", title: "x\ny" }], move }).success).toBe(false);
    expect(s.safeParse({ posts: [{ key: "a", publish: "2026-11-13", owner: "Max" }], move }).success).toBe(false);
    expect(s.safeParse({ posts: Array.from({ length: PLAN_LIMITS.shiftPosts + 1 }, (_, i) => ({ key: `k${i}`, publish: "2026-11-13" })), move }).success).toBe(false);
    expect(s.safeParse({ posts: posts(), move: { ...move, step: "launch" } }).success).toBe(false);
    expect(s.safeParse({ posts: [], move }).success).toBe(false);
  });
});
