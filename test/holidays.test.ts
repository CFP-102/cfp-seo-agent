import { describe, expect, it } from "vitest";
import { holidays, holidaysBetween, easter, HOLIDAY_REGIONS } from "../src/services/holidays.js";
import { contentMonthPlan } from "../src/services/contentMonthPlan.js";
import { contentPlanShift } from "../src/services/contentShift.js";
import { videoProjectPlan } from "../src/services/projectPlan.js";

describe("public holidays per region", () => {
  it("knows Easter and the regional days for Germany, Austria and Switzerland", () => {
    expect(easter(2026)).toBe("2026-04-05");
    expect(easter(2027)).toBe("2027-03-28");
    const by = holidays("DE-BY", 2026);
    expect([...by.keys()]).toEqual(expect.arrayContaining(["2026-01-06", "2026-04-03", "2026-04-06", "2026-05-14", "2026-05-25", "2026-06-04", "2026-08-15", "2026-10-03", "2026-11-01", "2026-12-25", "2026-12-26"]));
    expect(holidays("DE-SN", 2026).get("2026-11-18")).toBe("Buß- und Bettag"); // Wednesday before 23 November
    expect(holidays("DE-SN", 2027).has("2027-11-17")).toBe(true);
    expect(holidays("DE-BE", 2026).has("2026-03-08")).toBe(true);
    expect(holidays("DE-TH", 2026).has("2026-09-20")).toBe(true);
    expect(holidays("DE-HH", 2026).has("2026-10-31")).toBe(true);
    expect(holidays("DE-HH", 2026).has("2026-06-04")).toBe(false); // no Corpus Christi in Hamburg
    expect(holidays("DE-NW", 2026).has("2026-01-06")).toBe(false);
    const at = holidays("AT", 2026, "en");
    expect(at.get("2026-10-26")).toBe("Austrian National Day");
    expect(at.has("2026-12-08")).toBe(true);
    expect(at.has("2026-04-03")).toBe(false); // Good Friday is no general holiday in Austria
    expect(holidays("CH", 2026).has("2026-08-01")).toBe(true);
    expect(holidays("none", 2026).size).toBe(0);
    for (const r of HOLIDAY_REGIONS) for (const d of holidays(r, 2026).keys()) expect(d.startsWith("2026-"), `${r} ${d}`).toBe(true);
    expect([...holidaysBetween("DE-BY", "2026-12-20", "2027-01-07").keys()]).toEqual(["2026-12-25", "2026-12-26", "2027-01-01", "2027-01-06"]);
  });

  it("the month plan never publishes or shoots on a holiday of the chosen region, and lists them", () => {
    const base = { from: "2026-11-16", to: "2026-11-27", today: "2026-11-02", posts_per_week: 3, publish_weekdays: ["wed"], production_weekdays: ["wed", "thu"] };
    const plain = contentMonthPlan.executeLocal!(contentMonthPlan.inputSchema.parse(base));
    expect(plain.posts.map((p) => p.publish)).toContain("2026-11-18");
    const sn = contentMonthPlan.executeLocal!(contentMonthPlan.inputSchema.parse({ ...base, holiday_region: "DE-SN" }));
    expect(sn.holidays).toEqual([{ date: "2026-11-18", name: "Buß- und Bettag" }]);
    for (const p of sn.posts) for (const d of [p.publish, p.shoot, p.concept, p.edit, p.review]) expect(d, p.key).not.toBe("2026-11-18");
    expect(contentMonthPlan.inputSchema.safeParse({ ...base, holiday_region: "DE-XX" }).success).toBe(false);
  });

  it("the date move notes a changed date on a holiday, and the project plan warns about a holiday shoot day", () => {
    const posts = [{ key: "p1", title: "A", publish: "2026-12-18", shoot: "2026-12-14" }];
    const move = { post_key: "p1", step: "publish", new_date: "2026-12-25" };
    const none = contentPlanShift.executeLocal!(contentPlanShift.inputSchema.parse({ posts, move }));
    expect(none.conflicts.some((c) => c.message.includes("Feiertag"))).toBe(false);
    const by = contentPlanShift.executeLocal!(contentPlanShift.inputSchema.parse({ posts, move, holiday_region: "DE-BY", language: "en" }));
    expect(by.conflicts.find((c) => c.message.includes("public holiday"))).toMatchObject({ level: "warn", steps: ["publish"] });
    const pp = videoProjectPlan.executeLocal!(videoProjectPlan.inputSchema.parse({ goal: "recruiting", shoot_date: "2026-11-18", deliver_by: "2026-12-23", today: "2026-10-24", holiday_region: "DE-SN" }));
    expect(pp.warnings.join(" ")).toContain("Feiertag");
    expect(pp.post_production.holiday_region).toBe("DE-SN");
    const ppAt = videoProjectPlan.executeLocal!(videoProjectPlan.inputSchema.parse({ goal: "recruiting", shoot_date: "2026-12-01", deliver_by: "2026-12-23", today: "2026-10-24", holiday_region: "AT", language: "en" }));
    expect(ppAt.post_production.holidays_in_range).toContainEqual({ date: "2026-12-08", name: "Immaculate Conception" });
    for (const m of ppAt.post_production.milestones) for (const d of [m.start, m.end]) expect(d).not.toBe("2026-12-08");
  });
});
