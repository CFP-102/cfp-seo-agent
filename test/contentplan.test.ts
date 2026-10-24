import { describe, expect, it } from "vitest";
import { buildTestApp, fixture, PAY_TO } from "./helpers.js";
import { buyer, fakeFacilitator, post, routedUpstream, start, type Event } from "./x402helpers.js";
import { SERVICES } from "../src/services/index.js";
import { SERVICE_CONFIG, FACILITATOR_FEE_USD, PLAN_LIMITS, PLAN_SOURCES } from "../src/config/services.js";
import { sunTimes } from "../src/services/sunTimes.js";
import { videoRecipes, recipeDataset } from "../src/services/videoRecipes.js";
import { shootDayPlan } from "../src/services/shootPlan.js";
import { checkLocation, createShootLocationCheck, mapProtectedAreas, nearestStation, parseMosmix, protectedAreasUrl, simulatedAreas, simulatedKml, unzipKmz, weatherUrl } from "../src/services/shootLocationCheck.js";
import { deflateRawSync, crc32 } from "node:zlib";

const bin = (b: Buffer) => new Response(new Uint8Array(b));
/** Minimal zip with one deflated entry, like the DWD .kmz files. */
function kmz(kml: string, name = "forecast.kml"): Buffer {
  const raw = Buffer.from(kml, "latin1"), data = deflateRawSync(raw), file = Buffer.from(name);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8); local.writeUInt32LE(crc32(raw), 14);
  local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(file.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc32(raw), 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(file.length, 28);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(46 + file.length, 12); end.writeUInt32LE(30 + file.length + data.length, 16);
  return Buffer.concat([local, file, data, central, file, end]);
}

const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

describe("sun times", () => {
  it("match published values within a few minutes (Munich, winter solstice) and an independent solar-noon derivation (summer)", () => {
    const winter = sunTimes(48.137, 11.575, "2026-12-21");
    expect(Math.abs(minutes(winter.sunrise!) - minutes("08:01"))).toBeLessThanOrEqual(3);
    expect(Math.abs(minutes(winter.sunset!) - minutes("16:23"))).toBeLessThanOrEqual(3);
    // CEST: solar noon about 13:16 at 11.575 E; half day length 8 h 02 min at the solstice.
    const summer = sunTimes(48.137, 11.575, "2026-06-21");
    expect(Math.abs(minutes(summer.sunrise!) - minutes("05:14"))).toBeLessThanOrEqual(3);
    expect(Math.abs(minutes(summer.sunset!) - minutes("21:18"))).toBeLessThanOrEqual(3);
  });
  it("orders dawn, sunrise, golden hours, sunset and dusk and handles the daylight-saving change", () => {
    const t = sunTimes(47.867, 12.44, "2026-10-26"); // first Monday after the change to CET
    const order = [t.civil_dawn, t.sunrise, t.golden_hour_morning_ends, t.golden_hour_evening_starts, t.sunset, t.civil_dusk].map(v => minutes(v!));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(minutes(t.sunrise!)).toBeGreaterThan(minutes("06:00"));
    expect(minutes(t.sunset!)).toBeLessThan(minutes("18:00"));
  });
});

describe("video-recipes", () => {
  it.skipIf(recipeDataset.sample)("serves the operator's 75 recipes with a complete index and filters by category, words and exact id", () => {
    expect(recipeDataset.recipes).toHaveLength(75);
    const all = videoRecipes.executeLocal!(videoRecipes.inputSchema.parse({}));
    expect(all.index).toHaveLength(75); expect(all.recipes).toHaveLength(PLAN_LIMITS.recipeResults); expect(all.truncated).toBe(true);
    const tips = videoRecipes.executeLocal!(videoRecipes.inputSchema.parse({ category: "wissen" }));
    expect(tips.recipes.every(r => r.category === "wissen")).toBe(true);
    const one = videoRecipes.executeLocal!(videoRecipes.inputSchema.parse({ recipe_id: "tpl-kurzer-experten-tipp" }));
    expect(one.total_matches).toBe(1); expect(one.recipes[0]!.shots.length).toBeGreaterThan(0);
    expect(videoRecipes.executeLocal!(videoRecipes.inputSchema.parse({ query: "Maschine" })).recipes.some(r => r.id === "tpl-maschine-in-aktion")).toBe(true);
    expect(videoRecipes.executeLocal!(videoRecipes.inputSchema.parse({ recipe_id: "tpl-gibt-es-nicht" })).total_matches).toBe(0);
  });
  it("rejects unknown fields, other categories and oversized queries", () => {
    expect(videoRecipes.inputSchema.safeParse({ category: "krimi" }).success).toBe(false);
    expect(videoRecipes.inputSchema.safeParse({ query: "x".repeat(PLAN_LIMITS.queryChars + 1) }).success).toBe(false);
    expect(videoRecipes.inputSchema.safeParse({ url: "https://example.com" }).success).toBe(false);
  });
});

describe("shoot-day-plan", () => {
  const plan = (input: unknown) => shootDayPlan.executeLocal!(shootDayPlan.inputSchema.parse(input));
  const videos = (n: number, location?: (i: number) => string) => Array.from({ length: n }, (_, i) => ({ title: `Video ${i + 1}`, recipe_id: "tpl-produkt-in-30-sekunden", ...(location ? { location: location(i) } : {}) }));

  it("splits eight videos evenly (3/3/2), never more than three per day and never beyond the day limit", () => {
    const r = plan({ shoots: videos(8) });
    expect(r.days.map(d => d.shoots.length)).toEqual([3, 3, 2]);
    for (const d of r.days) expect(d.total_minutes).toBeLessThanOrEqual(480);
    expect(r.summary).toMatchObject({ shoots: 8, shoot_days: 3 });
  });
  it("keeps one place on one day where counts allow and adds breaks, one lunch break and a place-change note", () => {
    const r = plan({ shoots: [...videos(3, () => "Showroom"), ...videos(3, () => "Werkhalle").map((v, i) => ({ ...v, title: `Halle ${i + 1}` }))] });
    expect(r.days).toHaveLength(2);
    for (const d of r.days) expect(new Set(d.shoots.map(s => s.location)).size).toBe(1);
    const lunches = r.days[0]!.schedule.filter(x => x.label.startsWith("Mittagspause"));
    expect(lunches).toHaveLength(1);
    const mixed = plan({ shoots: [{ title: "A", location: "Showroom" }, { title: "B", location: "Werkhalle" }] });
    expect(mixed.days[0]!.schedule.some(x => x.label.includes("Ortswechsel → Werkhalle"))).toBe(true);
  });
  it("uses 1.5 to 2 hours per video and a shorter slot for photo posts", () => {
    const r = plan({ shoots: [{ title: "Reel", media_type: "reel", minutes: 20 }, { title: "Foto", media_type: "post", minutes: 20 }] });
    const slots = Object.fromEntries(r.days.flatMap(d => d.shoots).map(s => [s.title, s.minutes]));
    expect(slots.Reel).toBeGreaterThanOrEqual(90); expect(slots.Reel).toBeLessThanOrEqual(120);
    expect(slots.Foto).toBeGreaterThanOrEqual(45); expect(slots.Foto).toBeLessThanOrEqual(75);
  });
  it("spaces day dates two days apart and writes valid .ics text (CRLF, folded lines, escaped commas, stable UID)", () => {
    const r = plan({ shoots: videos(8), first_date: "2026-11-10" });
    expect(r.days.map(d => d.date)).toEqual(["2026-11-10", "2026-11-12", "2026-11-14"]);
    const ics = r.days[0]!.calendar_file_ics!;
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true); expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(ics).toContain("UID:shoot-2026-11-10-540@agent.chiemgaufilms.com"); expect(ics).toContain("DTSTART:20261110T090000");
    for (const line of ics.split("\r\n")) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
    expect(ics).toContain("Ankommen\\, Aufbau");
    expect(plan({ shoots: videos(2) }).days[0]!.calendar_file_ics).toBeNull();
  });
  it("lists equipment with counts and only adds microphone and question items when relevant", () => {
    const r = plan({ shoots: [{ title: "Interview", recipe_id: "tpl-mitarbeiter-vorstellen", equipment: ["Ansteckmikrofon"] }, { title: "Detail", recipe_id: "tpl-produktdetail" }] });
    const d = r.days[0]!;
    expect(d.equipment.length).toBeGreaterThan(0);
    expect(d.checklist).toContain("Interviewfragen vorab an die Beteiligten schicken");
    expect(d.checklist).toContain("Ansteckmikrofon testen");
    const none = plan({ shoots: [{ title: "Plain" }] }).days[0]!;
    expect(none.checklist).not.toContain("Ansteckmikrofon testen"); expect(none.checklist).not.toContain("Interviewfragen vorab an die Beteiligten schicken");
  });
  it("validates before payment: size, strict fields, control characters, real dates, unknown recipes", () => {
    const base = { shoots: videos(1) };
    expect(shootDayPlan.inputSchema.safeParse({ shoots: videos(PLAN_LIMITS.shoots + 1) }).success).toBe(false);
    expect(shootDayPlan.inputSchema.safeParse({ shoots: [] }).success).toBe(false);
    expect(shootDayPlan.inputSchema.safeParse({ shoots: [{ title: "x", people: ["Max Mustermann"] }] }).success).toBe(false);
    expect(shootDayPlan.inputSchema.safeParse({ shoots: [{ title: "bad\u0000title" }] }).success).toBe(false);
    expect(shootDayPlan.inputSchema.safeParse({ ...base, first_date: "2026-02-30" }).success).toBe(false);
    expect(shootDayPlan.inputSchema.safeParse({ ...base, start_time: "25:00" }).success).toBe(false);
    expect(shootDayPlan.validateInput!(shootDayPlan.inputSchema.parse({ shoots: [{ title: "x", recipe_id: "tpl-gibt-es-nicht" }] }))).toContain("Unknown recipe_id");
    expect(shootDayPlan.validateInput!(shootDayPlan.inputSchema.parse(base))).toBeNull();
  });
});

describe("shoot-location-check", () => {
  const NOW = new Date("2026-10-24T10:00:00Z");
  const input = { latitude: 47.8671, longitude: 12.4399, date: "2026-10-26" };
  const STATION = nearestStation(47.867, 12.44).station.id;
  const goodKmz = () => kmz(simulatedKml(STATION, "2026-10-26"));
  const respond = (urls: URL[], overrides: { weather?: () => Response; areas?: () => Response } = {}) => (async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(url)); urls.push(u);
    expect(init).toMatchObject({ method: "GET", redirect: "error", credentials: "omit" });
    if (u.host === "opendata.dwd.de") return overrides.weather?.() ?? bin(goodKmz());
    if (u.host === "www.lfu.bayern.de") return overrides.areas?.() ?? new Response(simulatedAreas);
    throw new Error("unexpected host " + u.host);
  }) as typeof fetch;

  it("picks the nearest official DWD forecast station from the bundled list", () => {
    expect(nearestStation(47.867, 12.44)).toMatchObject({ station: { id: "P875", name: "CHIEMSEE-HERRENCHIEM" } });
    expect(nearestStation(47.867, 12.44).distanceKm).toBeLessThan(6);
    expect(nearestStation(53.55, 10.0).distanceKm).toBeLessThan(15);
    expect(weatherUrl("P875").href).toBe(`${PLAN_SOURCES.weather}/P875/kml/MOSMIX_L_LATEST_P875.kmz`);
    expect(() => weatherUrl("../../etc")).toThrow();
  });
  it("makes exactly one weather and one protected-area request, to fixed hosts; the weather request carries no coordinates", async () => {
    const urls: URL[] = [];
    const r = await checkLocation(input, "live", respond(urls), NOW);
    expect(urls.map(u => u.origin + u.pathname).sort()).toEqual([`${PLAN_SOURCES.weather}/${STATION}/kml/MOSMIX_L_LATEST_${STATION}.kmz`, PLAN_SOURCES.protectedAreas].sort());
    for (const u of urls) expect(u.href).not.toMatch(/47\.8671|12\.4399/);
    expect(urls.find(u => u.host === "opendata.dwd.de")!.search).toBe("");
    expect(r.location).toMatchObject({ latitude: 47.867, longitude: 12.44 });
    expect(r.weather).toMatchObject({ available: true, simulated: false, station: { id: STATION } }); expect(r.protected_areas).toMatchObject({ checked: true, total_matches: 1 });
    expect(r.attributions.join(" ")).toContain("Bayerisches Landesamt für Umwelt"); expect(r.attributions.join(" ")).toContain("Deutscher Wetterdienst");
    expect(r.not_included.join(" ")).toContain("Drone");
  });
  it("always sends srsName with the box, because the server silently returns zero hits without it", () => {
    const u = protectedAreasUrl(47.867, 12.44);
    expect(u.searchParams.get("srsName")).toBe("urn:ogc:def:crs:EPSG::4326");
    expect(u.searchParams.get("bbox")).toBe("47.8645,12.436,47.8695,12.444,urn:ogc:def:crs:EPSG::4326");
    expect(u.searchParams.get("typeNames")!.split(",")).toHaveLength(5);
    expect(u.searchParams.get("propertyName")).toBe("name,id,status,area_ha");
  });
  it("converts units and summarizes a Berlin calendar day from UTC time steps", async () => {
    const r = await checkLocation(input, "live", respond([]), NOW);
    if (!r.weather.available) throw new Error("expected weather");
    expect(r.weather.hourly).toHaveLength(24); expect(r.weather.hourly[0]!.hour).toBe(0); expect(r.weather.hourly[23]!.hour).toBe(23);
    expect(r.weather.hourly[12]).toMatchObject({ temperature_c: 11.9, wind_speed_kmh: 14.4, wind_gust_kmh: 28.8, sunshine_minutes: 30, cloud_cover_percent: 60 });
    expect(r.weather.daily).toMatchObject({ precipitation_total_mm: 0, rainy_hours: 0, sunshine_total_minutes: 210, cloud_cover_mean_percent: 60, wind_gust_max_kmh: 28.8 });
    expect(r.weather.forecast_issued_at).toBe("2026-10-25T21:00:00.000Z");
  });
  it("skips the weather request beyond the forecast horizon and the protected-area request outside Bavaria", async () => {
    const far: URL[] = [];
    const a = await checkLocation({ ...input, date: "2026-12-24" }, "live", respond(far), NOW);
    expect(far.map(u => u.host)).toEqual(["www.lfu.bayern.de"]);
    expect(a.weather).toMatchObject({ available: false }); expect(a.sun.sunrise).not.toBeNull();
    const north: URL[] = [];
    const b = await checkLocation({ latitude: 53.55, longitude: 10.0, date: "2026-10-26" }, "live", (async (u: RequestInfo | URL, init?: RequestInit) => { north.push(new URL(String(u))); void init; return bin(kmz(simulatedKml(nearestStation(53.55, 10.0).station.id, "2026-10-26"))); }) as typeof fetch, NOW);
    expect(north.map(u => u.host)).toEqual(["opendata.dwd.de"]);
    expect(b.protected_areas).toMatchObject({ checked: false });
    const past: URL[] = [];
    expect((await checkLocation({ ...input, date: "2026-10-01" }, "live", respond(past), NOW)).weather).toMatchObject({ available: false });
  });
  it("never contacts a source in sandbox mode", async () => {
    let calls = 0;
    const r = await checkLocation(input, "sandbox", (async () => { calls++; throw new Error("no network"); }) as typeof fetch, NOW);
    expect(calls).toBe(0); expect(r.simulated).toBe(true);
    expect(r.weather).toMatchObject({ simulated: true }); expect(r.protected_areas).toMatchObject({ simulated: true });
  });
  it("fails the call if every queried source fails; one unusable source only marks that part unavailable", async () => {
    const partialWeather = await checkLocation(input, "live", respond([], { weather: () => new Response("busy", { status: 502 }) }), NOW);
    expect(partialWeather.weather).toMatchObject({ available: false });
    expect(partialWeather.protected_areas).toMatchObject({ checked: true });
    const partialAreas = await checkLocation(input, "live", respond([], { areas: () => new Response("busy", { status: 503 }) }), NOW);
    expect(partialAreas.protected_areas).toMatchObject({ checked: false });
    expect(partialAreas.weather).toMatchObject({ available: true });
    expect((await checkLocation(input, "live", respond([], { areas: () => new Response("<wfs:FeatureCollection>no count</wfs:FeatureCollection>") }), NOW)).protected_areas).toMatchObject({ checked: false });
    expect((await checkLocation(input, "live", respond([], { weather: () => new Response("not a zip") }), NOW)).weather).toMatchObject({ available: false });
    expect((await checkLocation(input, "live", respond([], { weather: () => bin(kmz(simulatedKml("XXXXX", "2026-10-26"))) }), NOW)).weather).toMatchObject({ available: false });
    expect((await checkLocation(input, "live", respond([], { areas: () => new Response('<ows:ExceptionReport><ows:Exception/></ows:ExceptionReport>') }), NOW)).protected_areas).toMatchObject({ checked: false });
    expect((await checkLocation(input, "live", respond([], { areas: () => new Response("<wfs:FeatureCollection>no count</wfs:FeatureCollection>") }), NOW)).protected_areas).toMatchObject({ checked: false });
    expect((await checkLocation(input, "live", respond([], { areas: () => new Response(new Uint8Array(PLAN_LIMITS.responseBytes + 1)) }), NOW)).protected_areas).toMatchObject({ checked: false });
    await expect(checkLocation(input, "live", (async () => { throw Object.assign(new Error("x"), { name: "TimeoutError" }); }) as typeof fetch, NOW)).rejects.toMatchObject({ code: "timeout" });
  });
  it("rejects malformed forecast files: bad time steps, missing or short series, decompression bombs", () => {
    const good = simulatedKml(STATION, "2026-10-26");
    expect(() => parseMosmix(good.replace(/<dwd:TimeStep>[^<]*<\/dwd:TimeStep>/, "<dwd:TimeStep>tomorrow</dwd:TimeStep>"), STATION)).toThrow();
    expect(() => parseMosmix(good.replace(/dwd:elementName="FF"/, 'dwd:elementName="XX"'), STATION)).toThrow();
    expect(() => parseMosmix(good.replace(/(<dwd:Forecast dwd:elementName="N"><dwd:value>)\S+ /, "$1"), STATION)).toThrow();
    expect(parseMosmix(good.replace(/(<dwd:Forecast dwd:elementName="N"><dwd:value>)[\d.]+ /, "$1- "), STATION).series.N[0]).toBeNull();
    expect(() => unzipKmz(kmz("x".repeat(PLAN_LIMITS.forecastUnpackedBytes + 10)))).toThrow();
    expect(unzipKmz(kmz("ok"))).toBe("ok");
  });
  it("decodes XML entities, strips control characters, caps the list and flags truncation", () => {
    const member = (n: number, name: string) => `<wfs:member><wfsschutzgebiete:naturschutzgebiet gml:id="naturschutzgebiet.${n}"><wfsschutzgebiete:name>${name}</wfsschutzgebiete:name><wfsschutzgebiete:area_ha>12.345</wfsschutzgebiete:area_ha></wfsschutzgebiete:naturschutzgebiet></wfs:member>`;
    const xml = `<wfs:FeatureCollection numberMatched="12">${member(1, "Schutz des &quot;Chiemsees&quot; &amp; Ufer&#10;neu")}${Array.from({ length: 11 }, (_, i) => member(i + 2, "G" + i)).join("")}</wfs:FeatureCollection>`;
    const r = mapProtectedAreas(xml, false);
    expect(r.areas).toHaveLength(PLAN_LIMITS.areaResults); expect(r.truncated).toBe(true); expect(r.total_matches).toBe(12);
    expect(r.areas[0]).toMatchObject({ type: "nature_reserve", name: 'Schutz des "Chiemsees" & Ufer neu', area_ha: 12.3 });
    expect(() => mapProtectedAreas(xml.replace(/<wfsschutzgebiete:naturschutzgebiet gml:id/, "<wfsschutzgebiete:fremde_ebene gml:id"), false)).toThrow();
  });
  it("accepts only coordinates inside Germany and real dates", () => {
    const s = createShootLocationCheck().inputSchema;
    expect(s.safeParse(input).success).toBe(true);
    expect(s.safeParse({ ...input, latitude: 40 }).success).toBe(false);
    expect(s.safeParse({ ...input, longitude: 20 }).success).toBe(false);
    expect(s.safeParse({ ...input, date: "2026-13-01" }).success).toBe(false);
    expect(s.safeParse({ ...input, url: "https://evil.example" }).success).toBe(false);
    expect(s.safeParse({ ...input, latitude: "47.8" }).success).toBe(false);
  });
});

describe("content planning services: pricing, category and payment order", () => {
  const film = ["video-recipes", "shoot-day-plan", "shoot-location-check", "content-month-plan", "content-plan-shift", "video-project-plan"];
  it("are in the content planning category, priced above cost plus facilitator fee and not copied from a competitor price", () => {
    for (const id of film) {
      const c = SERVICE_CONFIG[id]!;
      expect(c.category, id).toBe("content");
      expect(Number(c.priceUsdc), id).toBeGreaterThan(c.worstCaseUsd + FACILITATOR_FEE_USD);
      expect(c.referencePriceUsdc, id).toBeNull();
    }
    expect(SERVICES.filter(s => film.includes(s.id))).toHaveLength(6);
    expect(Object.values(SERVICE_CONFIG).filter(c => c.category === "content")).toHaveLength(6);
  });
  it("the location-check package is excluded from free samples while the local planning services stay eligible", async () => {
    const { app } = buildTestApp({ fetchImpl: routedUpstream([]).impl });
    const catalog = await (await fetch((await start(app)) + "/api/v1/services")).json();
    const by = Object.fromEntries(catalog.services.map((s: any) => [s.id, s]));
    for (const id of film) expect(by[id].category).toBe("content");
    expect(by["keyword-metrics"].category).toBe("data");
  });
  it("settles before the two source requests and a replay of the same payment does not fetch again", async () => {
    const events: Event[] = []; const hosts: string[] = [];
    const date = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const service = createShootLocationCheck((async (url: RequestInfo | URL) => {
      expect(events).toEqual(["settle"]); const u = new URL(String(url)); hosts.push(u.host);
      return u.host === "opendata.dwd.de" ? bin(kmz(simulatedKml(nearestStation(47.867, 12.44).station.id, date))) : new Response(simulatedAreas);
    }) as typeof fetch);
    const fac = fakeFacilitator(events);
    const { app } = buildTestApp({ fetchImpl: routedUpstream(events).impl, facilitator: fac, services: [service], env: { PAYMENT_MODE: "testnet", PAY_TO_ADDRESS: PAY_TO, DATAFORSEO_MODE: "live", ALLOW_LIVE_DATA_ON_TESTNET: "true", DATAFORSEO_LOGIN: "fake", DATAFORSEO_PASSWORD: "fake" } });
    const base = await start(app);
    const body = { latitude: 47.867, longitude: 12.44, date };
    expect((await fetch(base + service.route, post(body))).status).toBe(402); expect(hosts).toEqual([]);
    const { pay, sent } = buyer();
    const response = await pay(base + service.route, post(body));
    expect(response.status).toBe(200); const result = await response.json();
    expect(result).toMatchObject({ data_source: "live", result: { simulated: false } }); expect(hosts.sort()).toEqual(["opendata.dwd.de", "www.lfu.bayern.de"]);
    const signature = sent.map(h => h.get("payment-signature")).find(Boolean)!;
    expect((await fetch(base + service.route, post(body, { "payment-signature": signature }))).status).toBe(200);
    expect(hosts).toHaveLength(2); expect(fac.settles()).toBe(1);
  });
  it("rejects an invalid location check before any price is quoted", async () => {
    const { app } = buildTestApp({ fetchImpl: routedUpstream([]).impl, env: { PAYMENT_MODE: "testnet", PAY_TO_ADDRESS: PAY_TO, DATAFORSEO_LOGIN: "fake", DATAFORSEO_PASSWORD: "fake" } });
    const res = await fetch((await start(app)) + "/api/v1/shoot-location-check", post({ latitude: 10, longitude: 12.4, date: "2026-10-26" }));
    expect(res.status).toBe(400); // invalid input is refused with 400 and never reaches the 402 price quote
    expect(res.headers.get("payment-required")).toBeNull();
  });
  it("shows the content planning services in their own website section and keeps them out of the data section", async () => {
    const { app } = buildTestApp({ fetchImpl: routedUpstream([]).impl });
    const base = await start(app);
    for (const path of ["/", "/de/"]) {
      const html = await (await fetch(base + path)).text();
      const [data, filmPart] = html.split('<section id="content"');
      expect(filmPart, path).toBeDefined();
      for (const id of film) { expect(filmPart!, path + id).toContain(`data-id="${id}"`); expect(data!, path + id).not.toContain(`data-id="${id}"`); }
      expect(data!).toContain('data-id="keyword-metrics"'); expect(filmPart!).not.toContain('data-id="keyword-metrics"');
    }
    const llms = await (await fetch(base + "/llms.txt")).text();
    expect(llms).toContain("Content planning for agencies"); expect(llms.split("Content planning for agencies")[1]).toContain("shoot-day-plan");
    expect(fixture("shoot-location-check.json").tasks).toHaveLength(1);
  });
});
