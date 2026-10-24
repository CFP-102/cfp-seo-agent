import { describe, expect, it } from "vitest";
import { IDEAS, videoProjectPlan } from "../src/services/projectPlan.js";
import { recipeDataset } from "../src/services/videoRecipes.js";
import { bavarianHolidays } from "../src/services/dates.js";
import { matchTrade } from "../src/services/trades.js";

const parse = (x: unknown) => videoProjectPlan.inputSchema.parse(x);
const run = (x: unknown) => videoProjectPlan.executeLocal!(parse(x));
const chieming = { goal: "recruiting", industry: "Metallbau", town: "Chieming", shoot_date: "2026-11-20", day_start: "08:00", day_end: "17:00", deliver_by: "2026-12-23", reel_count_min: 5, reel_count_max: 10, latitude: 47.89, longitude: 12.54, today: "2026-10-24" };

// Tests marked skipIf(sample) need the operator's full recipe set, which the public repository replaces with a small sample.
describe("video-project-plan", () => {
  it.skipIf(recipeDataset.sample)("plans the customer's one shoot day inside the window with trade-specific ideas and delivers on time", () => {
    const r = run(chieming);
    expect(r.project).toMatchObject({ trade_matched: "Metallbau", job: "Metallbauer:in", town: "Chieming" });
    expect(r.summary.reels_planned).toBeGreaterThanOrEqual(5);
    expect(r.summary.reels_planned).toBeLessThanOrEqual(10);
    expect(r.summary.shoot_day.fits_window).toBe(true);
    const rows = r.shoot_day.schedule;
    expect(rows[0]!.start).toBe("08:00");
    expect(rows.at(-1)!.end <= "17:00").toBe(true);
    for (let k = 1; k < rows.length; k++) expect(rows[k]!.start).toBe(rows[k - 1]!.end); // gapless, no overlaps
    expect(rows.filter(x => x.label === "Mittagspause")).toHaveLength(1);
    expect(r.reels.some(x => x.title.includes("Schweißen"))).toBe(true);
    expect(r.reels.some(x => x.title.includes("Chieming"))).toBe(true);
    expect(r.checklist.some(c => c.includes("Schutzfilter"))).toBe(true);
    expect(r.shoot_day.sun?.sunset).toMatch(/^16:\d\d$/);
    expect(r.summary.on_time).toBe(true);
    expect(r.post_production.milestones[0]!.start).toBe("2026-11-23"); // shoot is a Friday: next working day is Monday
    expect(r.post_production.milestones.at(-1)!.end <= "2026-12-23").toBe(true);
    expect(r.calendar_file_ics).toContain("DTSTART:20261120T080000");
    expect(r.calendar_file_ics).toContain("SUMMARY:Abgabe an den Kunden");
  });

  it("plans the customer's own reels first and reports when the minimum does not fit the window", () => {
    const r = run({ ...chieming, day_start: "09:00", day_end: "13:00", reel_count_min: 6, reel_count_max: undefined, reels: [{ title: "Lieferung zur Baustelle", outdoor: true, recording_minutes: 20 }, { title: "Unser Hallenkran", location: "Halle" }] });
    expect(r.summary.reels_from_customer).toBe(2);
    expect(r.reels.filter(x => x.source === "customer").map(x => x.title).sort()).toEqual(["Lieferung zur Baustelle", "Unser Hallenkran"]);
    expect(r.reels[0]!.outdoor).toBe(true); // daylight first
    expect(r.summary.shoot_day.fits_window).toBe(false);
    expect(r.warnings.join(" ")).toMatch(/Ins Zeitfenster passen \d Reels/);
  });

  it("warns when outdoor shots start before sunrise and keeps lunch near midday", () => {
    const early = run({ ...chieming, shoot_date: "2026-12-14", deliver_by: "2027-01-29", day_start: "06:30", reels: [{ title: "Hof im Morgenlicht", outdoor: true }] });
    expect(early.warnings.join(" ")).toMatch(/beginnen vor .* \(Sonnenaufgang 0\d:\d\d\)/);
    const late = run({ ...chieming, day_start: "13:00", day_end: "20:00", reel_count_min: 4, reel_count_max: undefined, latitude: undefined, longitude: undefined });
    expect(late.shoot_day.schedule.find(r => r.label === "Mittagspause")).toBeUndefined();
  });

  it.skipIf(recipeDataset.sample)("keeps reels beyond the window as reserve instead of overbooking", () => {
    const r = run({ ...chieming, day_end: "13:00", reel_count_min: 2, reel_count_max: 10 });
    expect(r.summary.shoot_day.fits_window).toBe(true);
    expect(r.reserve.length).toBeGreaterThan(0);
  });

  it("counts working days without weekends, Bavarian holidays, 24 and 31 December and warns with a concrete alternative", () => {
    const r = run({ ...chieming, shoot_date: "2026-12-14", deliver_by: "2026-12-22", reel_count_min: 6, reel_count_max: undefined });
    expect(r.summary.on_time).toBe(false);
    for (const m of r.post_production.milestones) for (const d of [m.start, m.end]) expect(["2026-12-24", "2026-12-25", "2026-12-26", "2026-12-31"]).not.toContain(d);
    expect(r.warnings.join(" ")).toMatch(/Mit 1 Runde\(n\): fertig am 20\d\d-\d\d-\d\d/);
    const h = bavarianHolidays(2026);
    expect(h.get("2026-04-06")).toBe("Ostermontag");
    expect(h.get("2026-06-04")).toBe("Fronleichnam");
    expect(h.get("2026-05-14")).toBe("Christi Himmelfahrt");
  });

  it("falls back to neutral wording for unknown trades and uses the customer's areas and job titles", () => {
    const r = run({ ...chieming, industry: "Softwarefirma", job_titles: ["Entwickler:in"], locations: ["Großraumbüro", "Besprechungsraum"], latitude: undefined, longitude: undefined });
    expect(r.project.trade_matched).toBeNull();
    expect(r.reels.every(x => ["Großraumbüro", "Besprechungsraum"].includes(x.location))).toBe(true);
    expect(r.reels.some(x => x.title.includes("Entwickler:in"))).toBe(true);
    expect(r.shoot_day.sun).toBeNull();
    expect(matchTrade("Maschinenbau")).toBeNull(); // "bau" alone must not select the construction trade
    expect(matchTrade("Schlosserei Huber")?.id).toBe("metallbau");
    expect(matchTrade("Holzbau Maier")?.id).toBe("zimmerei");
    expect(matchTrade("Garten- und Landschaftspflege")).toBeNull();
    expect(matchTrade("Ambulanter Pflegedienst")?.id).toBe("pflege");
  });

  it.skipIf(recipeDataset.sample)("every idea template points to an existing recipe", () => {
    const ids = new Set(recipeDataset.recipes.map(r => r.id));
    for (const [goal, list] of Object.entries(IDEAS)) for (const t of list) expect(ids.has(t.recipe), `${goal}: ${t.recipe}`).toBe(true);
    for (const goal of Object.keys(IDEAS)) expect(run({ ...chieming, goal, reel_count_min: 1, reel_count_max: 12 }).reels.length).toBeGreaterThan(0);
  });

  it("validates dates, window and recipes before any price is quoted", () => {
    const v = (x: object) => videoProjectPlan.validateInput!(parse({ ...chieming, ...x }));
    expect(v({})).toBeNull();
    expect(v({ shoot_date: "2026-10-01" })).toContain("past");
    expect(v({ deliver_by: "2026-11-19" })).toContain("after shoot_date");
    expect(v({ day_start: "08:00", day_end: "11:00" })).toContain("4 hours");
    expect(v({ reels: [{ title: "x", recipe_id: "tpl-gibt-es-nicht" }] })).toContain("Unknown recipe_id");
    const s = videoProjectPlan.inputSchema;
    expect(s.safeParse({ ...chieming, latitude: 47.9, longitude: undefined }).success).toBe(false);
    expect(s.safeParse({ ...chieming, reel_count_min: 6, reel_count_max: 5 }).success).toBe(false);
    expect(s.safeParse({ ...chieming, town: "Chie\u0000ming" }).success).toBe(false);
    expect(s.safeParse({ ...chieming, goal: "werbung" }).success).toBe(false);
    expect(s.safeParse({ ...chieming, extra: 1 }).success).toBe(false);
  });
});
