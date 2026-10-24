import { describe, expect, it } from "vitest";
import { webcrypto } from "node:crypto";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { buildTestApp, PAY_TO } from "./helpers.js";
import { fakeFacilitator, post, routedUpstream, start, type Event } from "./x402helpers.js";

import { loadPlanner, type Planner } from "./plannerHelper.js";

const walletOf = (account: ReturnType<typeof privateKeyToAccount>) => ({
  address: account.address.toLowerCase(),
  signTypedData: async (json: string) => {
    const t = JSON.parse(json);
    const { EIP712Domain: _d, ...types } = t.types;
    return account.signTypedData({ domain: t.domain, types, primaryType: t.primaryType, message: t.message });
  },
});

const form = (period: { from: string; to: string }) => ({
  from: period.from, to: period.to, mode: "weekly", postsPerWeek: "3", categories: ["produkt", "mitarbeiter", "bts"], mix: {},
  publishDays: ["mon", "wed", "fri"], productionDays: ["tue", "thu"], existingPublish: "", existingShoot: "", avoidWeekends: true, startTime: "09:00",
});

async function buy(base: string, pay: Planner, path: string, input: unknown) {
  const quote = await fetch(base + path, post(input));
  expect(quote.status).toBe(402);
  const service = (await (await fetch(base + "/api/v1/services")).json()).services.find((s: any) => s.path === path);
  const p = await pay.buildPayment(quote.headers.get("payment-required"), { payTo: PAY_TO, network: "eip155:84532", priceUsdc: service.price_usdc }, walletOf(privateKeyToAccount(generatePrivateKey())), Math.floor(Date.now() / 1000), webcrypto, async () => true);
  const res = await fetch(base + path, { ...post(input), headers: { "content-type": "application/json", "payment-signature": p.header } });
  expect(res.status).toBe(200);
  return res.json();
}

describe("content planner (browser logic)", () => {
  it("runs the whole flow with simulated payments: form -> preflight -> plan -> file -> move -> review -> apply -> report", async () => {
    const events: Event[] = [];
    const { app } = buildTestApp({ fetchImpl: routedUpstream(events).impl, facilitator: fakeFacilitator(events) });
    const base = await start(app);
    const { planner, pay } = loadPlanner("en");
    const info = planner.schemaInfo(await (await fetch(base + "/openapi.json")).json());
    expect(info.categories).toContain("recruiting");
    expect(info.existingMax).toBeGreaterThan(0);
    const today = new Date().toISOString().slice(0, 10);
    const input = planner.buildMonthInput(form(planner.defaultPeriod(today)), info, today);
    expect(input).toMatchObject({ language: "en", posts_per_week: 3, today });
    expect(input.from > today).toBe(true);
    expect((await fetch(base + "/api/v1/preflight/content-month-plan", post(input))).status).toBe(200);

    const paid = await buy(base, pay, "/api/v1/content-month-plan", input);
    expect(events).toEqual(["settle"]); // exactly one purchase, no upstream data call for a local service
    const plan = planner.planFromResult(paid.result);
    expect(plan.posts.length).toBeGreaterThan(0);
    expect(plan.posts.every((p: any) => p.shoot_group)).toBe(true);
    expect(planner.hasErrors(plan)).toBe(false);
    expect(plan.ics).toMatch(/^BEGIN:VCALENDAR/);

    // file export/import round trip, without any payment data
    const file = planner.exportPlan({ plan, original: plan }, "Client A – spring", new Date());
    const text = JSON.stringify(file);
    expect(text).not.toMatch(/result_token|request_id|payment|signature|0x[0-9a-fA-F]{40}/);
    const loaded = planner.importPlan(text);
    expect(loaded.plan).toEqual({ ...plan, ics: null }); // calendar text is rebuilt from the dates after loading
    expect(loaded.title).toBe("Client A – spring");

    // separately approved move: shift the first post's shoot by two days, mark its concept done
    loaded.plan.posts[0].done = ["concept"];
    const first = loaded.plan.posts[0];
    const move = { post_key: first.key, step: "shoot", new_date: planner.addDays(first.shoot, 2), shoot_mode: "group" };
    const shiftReq = planner.shiftInput(loaded.plan, move, info);
    expect(shiftReq.posts[0]).toMatchObject({ key: first.key, done: ["concept"], shoot_group: first.shoot_group });
    expect(shiftReq.language).toBe("en");
    expect((await fetch(base + "/api/v1/preflight/content-plan-shift", post(shiftReq))).status).toBe(200);
    const shifted = await buy(base, pay, "/api/v1/content-plan-shift", shiftReq);
    expect(events).toEqual(["settle", "settle"]);
    const rows = planner.changeRows(loaded.plan, shifted.result);
    expect(rows.length).toBeGreaterThan(0);
    const before = JSON.stringify(loaded.plan);
    const next = planner.applyShift(loaded.plan, shifted.result);
    expect(JSON.stringify(loaded.plan)).toBe(before); // the original stays untouched
    expect(next.shifts).toBe(1);
    expect(next.ics).toBeNull(); // the server calendar file is out of date after a move
    const groupMembers = next.posts.filter((p: any) => p.shoot_group === first.shoot_group);
    expect(groupMembers.every((p: any) => p.shoot === move.new_date)).toBe(true);
    expect(next.posts[0].concept).toBe(first.concept); // done step not moved
    const day = next.shoot_days.find((d: any) => d.key === first.shoot_group);
    expect(day).toMatchObject({ date: move.new_date, times_valid: false });

    // calendar, decisions and calendar text from the current dates
    expect(planner.months(next).length).toBeGreaterThan(0);
    const decisions = planner.nextDecisions(next, today);
    expect(decisions.some((d: string) => d.includes("Book shoot day"))).toBe(true);
    const ics = planner.icsFromPlan(next, "20261024T000000Z");
    expect(ics.split("BEGIN:VEVENT").length - 1).toBe(planner.events(next).length);
    expect(ics).not.toMatch(/\r\n[^ A-Z]/);
  });

  it("validates the form before any request and only sends schema fields", () => {
    const { planner } = loadPlanner("de");
    const info = { categories: ["produkt", "bts"], weekdays: ["mon", "tue"], postsPerWeek: { min: 1, max: 7 }, mixMax: 30, existingMax: 3, shiftPostsMax: 40 };
    const today = "2026-10-24";
    const ok = { ...form({ from: "2026-11-02", to: "2026-11-27" }), categories: ["produkt", "unbekannt"] };
    expect(planner.buildMonthInput(ok, info, today).categories).toEqual(["produkt"]);
    expect(() => planner.buildMonthInput({ ...ok, from: "2026-02-30" }, info, today)).toThrow(/gültiges Datum/);
    expect(() => planner.buildMonthInput({ ...ok, to: "2026-11-01" }, info, today)).toThrow(/vor dem Anfang/);
    expect(() => planner.buildMonthInput({ ...ok, from: "2026-10-24", to: "2026-10-30" }, info, today)).toThrow(/Zukunft/);
    expect(() => planner.buildMonthInput({ ...ok, publishDays: [] }, info, today)).toThrow(/Veröffentlichungs/);
    expect(() => planner.buildMonthInput({ ...ok, categories: [] }, info, today)).toThrow(/Thema/);
    expect(() => planner.buildMonthInput({ ...ok, mode: "mix", mix: { produkt: "0" } }, info, today)).toThrow(/Themenmix/);
    expect(planner.buildMonthInput({ ...ok, mode: "mix", mix: { produkt: "99", bts: "2", evil: "5" } }, info, today).mix_counts).toEqual({ produkt: 30, bts: 2 });
    expect(() => planner.buildMonthInput({ ...ok, existingPublish: "2026-11-05\nmorgen" }, info, today)).toThrow(/morgen/);
    expect(() => planner.buildMonthInput({ ...ok, existingShoot: "2026-11-05 2026-11-06 2026-11-07 2026-11-08" }, info, today)).toThrow(/höchstens 3/);
    expect(planner.buildMonthInput({ ...ok, existingShoot: "2026-11-06, 2026-11-05\n2026-11-05" }, info, today).existing_shoot_dates).toEqual(["2026-11-05", "2026-11-06"]);
    expect(planner.buildMonthInput({ ...ok, postsPerWeek: "50" }, info, today).posts_per_week).toBe(7);
    expect(planner.buildMonthInput({ ...ok, startTime: "25:00" }, info, today)).not.toHaveProperty("start_time");
  });

  it("marks a plan with error conflicts or missing shoot dates as not usable", () => {
    const { planner } = loadPlanner("de");
    const base = { posts: [{ key: "p1", title: "A", publish: "2026-11-10", shoot: "2026-11-05", shoot_day: "d1" }], shoot_days: [{ key: "d1", date: "2026-11-05" }], conflicts: [], warnings: [] };
    expect(planner.hasErrors(planner.planFromResult(base))).toBe(false);
    expect(planner.hasErrors(planner.planFromResult({ ...base, conflicts: [{ level: "error", post_key: "p1", steps: ["shoot"], message: "kein Drehtermin" }] }))).toBe(true);
    expect(planner.hasErrors(planner.planFromResult({ ...base, posts: [{ key: "p1", title: "A", publish: "2026-11-10" }] }))).toBe(true);
  });
});

describe("content planner with a disabled service", () => {
  it("shows the unavailable note, marks the service disabled in the catalog and refuses preflight and quotes", async () => {
    const { app } = buildTestApp({ fetchImpl: routedUpstream([]).impl, facilitator: fakeFacilitator([]), disabled: ["content-plan-shift"], env: { PAY_TO_ADDRESS: PAY_TO } });
    const base = await start(app);
    for (const path of ["/planner", "/de/planer"]) expect(await (await fetch(base + path)).text()).toMatch(/currently unavailable|derzeit nicht verfügbar/);
    const catalog = await (await fetch(base + "/api/v1/services")).json();
    expect(catalog.services.find((s: any) => s.id === "content-plan-shift").enabled).toBe(false);
    const { planner } = loadPlanner("en");
    const plan = planner.planFromResult({ posts: [{ key: "p1", title: "A", publish: "2026-11-10", shoot: "2026-11-05", shoot_day: "d1" }], shoot_days: [{ key: "d1", date: "2026-11-05" }], conflicts: [], warnings: [] });
    const input = planner.shiftInput(plan, { post_key: "p1", step: "publish", new_date: "2026-11-12", publish_mode: "shift_all" }, null);
    expect((await fetch(base + "/api/v1/preflight/content-plan-shift", post(input))).status).toBe(503);
    expect((await fetch(base + "/api/v1/content-plan-shift", post(input))).status).not.toBe(402); // no price offer for a disabled service
  });
});

describe("content planner: holidays and script infos", () => {
  it("sends the holiday region, keeps it for moves and buys script infos for one post with a separate payment", async () => {
    const events: Event[] = [];
    const { app } = buildTestApp({ fetchImpl: routedUpstream(events).impl, facilitator: fakeFacilitator(events) });
    const base = await start(app);
    const { planner, pay } = loadPlanner("de");
    const info = planner.schemaInfo(await (await fetch(base + "/openapi.json")).json());
    expect(info.regions).toEqual(expect.arrayContaining(["none", "DE-BY", "DE-SN", "AT", "CH"]));
    const today = "2026-10-24";
    const input = planner.buildMonthInput({ ...form({ from: "2026-11-16", to: "2026-11-27" }), region: "DE-SN", publishDays: ["wed"] }, info, today);
    expect(input.holiday_region).toBe("DE-SN");
    expect(planner.buildMonthInput({ ...form({ from: "2026-11-16", to: "2026-11-27" }), region: "XX" }, info, today)).not.toHaveProperty("holiday_region");
    const paid = await buy(base, pay, "/api/v1/content-month-plan", input);
    const plan = planner.planFromResult(paid.result);
    expect(plan.holiday_region).toBe("DE-SN");
    expect(plan.holidays).toEqual([{ date: "2026-11-18", name: "Buß- und Bettag" }]);
    expect(plan.posts.every((p: any) => p.publish !== "2026-11-18")).toBe(true);
    expect(planner.shiftInput(plan, { post_key: plan.posts[0].key, step: "publish", new_date: "2026-11-25" }, info).holiday_region).toBe("DE-SN");
    const withRecipe = plan.posts.find((p: any) => p.recipe_id);
    expect(withRecipe).toBeTruthy();
    const scriptReq = { recipe_id: withRecipe.recipe_id, language: "de" };
    expect((await fetch(base + "/api/v1/preflight/video-recipes", post(scriptReq))).status).toBe(200);
    const bought = await buy(base, pay, "/api/v1/video-recipes", scriptReq);
    expect(events.filter((e) => e === "settle")).toHaveLength(2);
    const script = planner.cleanScript(bought.result.recipes[0]);
    expect(script.recipe_id).toBe(withRecipe.recipe_id);
    expect(script.shots.length).toBeGreaterThan(0);
    plan.scripts[withRecipe.key] = script;
    const back = planner.importPlan(JSON.stringify(planner.exportPlan({ plan, original: plan }, "", new Date()))).plan;
    expect(back.scripts[withRecipe.key]).toEqual(script);
  });
});

describe("video project planner (browser logic)", () => {
  const job = (today: string, planner: Planner) => ({
    goal: "recruiting", industry: "Metallbau", town: "Chieming", job: "", shootDate: planner.addDays(today, 20), dayStart: "08:00", dayEnd: "17:00",
    deliverBy: planner.addDays(today, 50), reelMin: "5", reelMax: "8", ideas: "Ein Tag in der Werkstatt\n", locations: "Werkstatt, Büro",
    region: "DE-BY", rounds: "2", lat: "47,88", lon: "12.53",
  });
  it("runs form -> preflight -> one purchase -> readable plan with calendar file", async () => {
    const events: Event[] = [];
    const { app } = buildTestApp({ fetchImpl: routedUpstream(events).impl, facilitator: fakeFacilitator(events) });
    const base = await start(app);
    const { planner, pay, project } = loadPlanner("de");
    const info = project.projectInfo(await (await fetch(base + "/openapi.json")).json());
    expect(info.goals).toEqual(["recruiting", "produkt", "unternehmen"]);
    expect(info.regions).toContain("DE-NW");
    const today = new Date().toISOString().slice(0, 10);
    const input = project.buildProjectInput(job(today, planner), info, today);
    expect(input).toMatchObject({ goal: "recruiting", language: "de", holiday_region: "DE-BY", latitude: 47.88, longitude: 12.53, reels: [{ title: "Ein Tag in der Werkstatt" }], locations: ["Werkstatt", "Büro"], review_rounds: 2 });
    expect(input).not.toHaveProperty("job_titles"); // empty optional fields are left out
    expect((await fetch(base + "/api/v1/preflight/video-project-plan", post(input))).status).toBe(200);
    const paid = await buy(base, pay, "/api/v1/video-project-plan", input);
    expect(events).toEqual(["settle"]);
    const r = paid.result;
    expect(r.reels.some((x: any) => x.title === "Ein Tag in der Werkstatt" && x.source === "customer")).toBe(true); // ordered by area, not by input
    expect(r.reels.length).toBe(r.summary.reels_planned); // count depends on the installed recipe file (public repo: samples only)
    expect(r.summary.shoot_day.fits_window).toBe(true);
    expect(r.shoot_day.sun).toBeTruthy();
    expect(r.calendar_file_ics).toMatch(/^BEGIN:VCALENDAR/);
    // fields the page renders exist in the result
    for (const reel of r.reels) expect(reel).toMatchObject({ slot: { start: expect.any(String), end: expect.any(String) }, shots: expect.any(Array), questions: expect.any(Array) });
    expect(r.post_production.milestones.length).toBeGreaterThan(2);
    expect(Array.isArray(r.post_production.holidays_in_range)).toBe(true);
  });
  it("checks the form before any price is shown", () => {
    const { planner, project } = loadPlanner("en");
    const info = project.projectInfo({});
    const today = "2026-10-24";
    const ok = job(today, planner);
    expect(() => project.buildProjectInput({ ...ok, shootDate: "2026-10-01" }, info, today)).toThrow(/past/);
    expect(() => project.buildProjectInput({ ...ok, deliverBy: ok.shootDate }, info, today)).toThrow(/after the shoot/);
    expect(() => project.buildProjectInput({ ...ok, shootDate: "2026-02-30" }, info, today)).toThrow(/valid date/);
    expect(() => project.buildProjectInput({ ...ok, dayEnd: "10:00" }, info, today)).toThrow(/4 hours/);
    expect(() => project.buildProjectInput({ ...ok, reelMin: "9", reelMax: "3" }, info, today)).toThrow(/minimum/);
    expect(() => project.buildProjectInput({ ...ok, lat: "47.9", lon: "" }, info, today)).toThrow(/together/);
    expect(() => project.buildProjectInput({ ...ok, lat: "40", lon: "12" }, info, today)).toThrow(/Germany/);
    expect(() => project.buildProjectInput({ ...ok, town: "Chie\u0000ming" }, info, today)).toThrow(/not allowed/);
    expect(() => project.buildProjectInput({ ...ok, locations: "a,b,c,d,e,f,g" }, info, today)).toThrow(/areas/);
    expect(() => project.buildProjectInput({ ...ok, deliverBy: planner.addDays(ok.shootDate, 181) }, info, today)).toThrow(/180 days/);
    expect(project.buildProjectInput({ ...ok, goal: "<script>", region: "XX", lat: "", lon: "" }, info, today)).toMatchObject({ goal: "recruiting", language: "en" });
    expect(project.buildProjectInput({ ...ok, region: "XX", lat: "", lon: "" }, info, today)).not.toHaveProperty("latitude");
  });
});

describe("planner buyer", () => {
  it("cannot be cancelled while a purchase runs, so the page never claims 'nothing was paid' during a wallet prompt", () => {
    const { planner } = loadPlanner("en");
    let busy = false;
    const box = { hidden: false };
    const buyer = planner.createBuyer({ $: () => box, kinds: { plan: { box: "b", out: "o" } }, isBusy: () => busy });
    busy = true;
    expect(buyer.cancel("plan")).toBe(false);
    expect(box.hidden).toBe(false);
    busy = false;
    expect(buyer.cancel("plan")).toBe(true);
    expect(box.hidden).toBe(true);
  });
});
