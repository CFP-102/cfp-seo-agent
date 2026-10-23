import { describe, expect, it } from "vitest";
import { createExternalUptime } from "../src/lib/externalUptime.js";
import { renderStatusPage } from "../src/web/statusPage.js";
import { buildStatus } from "../src/web/status.js";
import { buildTestApp } from "./helpers.js";
import { routedUpstream } from "./x402helpers.js";

const ok = (ratio: string, status = 2) =>
  (async () => new Response(JSON.stringify({ stat: "ok", monitors: [{ status, custom_uptime_ratio: ratio }] }))) as unknown as typeof fetch;

describe("independent uptime (UptimeRobot, fetched by the server)", () => {
  it("parses status and 1/7/30-day ratios, caches, and keeps the last value on errors", async () => {
    let calls = 0;
    let fail = false;
    let now = 0;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls++;
      expect(url).toBe("https://api.uptimerobot.com/v2/getMonitors");
      expect(String(init.body)).toContain("custom_uptime_ratios=1-7-30");
      if (fail) throw new Error("down");
      return new Response(JSON.stringify({ stat: "ok", monitors: [{ status: 2, custom_uptime_ratio: "100.000-99.950-99.912" }] }));
    }) as unknown as typeof fetch;
    const ext = createExternalUptime({ apiKey: "k", fetchImpl, ttlMs: 1000, now: () => new Date(now) });
    const a = await ext.get();
    expect(a).toMatchObject({ status: "up", uptime_pct: { last_24h: 100, last_7d: 99.95, last_30d: 99.91 } });
    await ext.get();
    expect(calls).toBe(1); // cached
    now = 5000;
    fail = true;
    await ext.get();
    await new Promise((r) => setTimeout(r, 10));
    expect((await ext.get())?.uptime_pct.last_7d).toBe(99.95); // last good value kept
  });

  it("maps down/paused and ignores failed API answers", async () => {
    expect((await createExternalUptime({ apiKey: "k", fetchImpl: ok("90-90-90", 9) }).get())?.status).toBe("down");
    expect((await createExternalUptime({ apiKey: "k", fetchImpl: ok("0-0-0", 0) }).get())?.status).toBe("paused");
    const bad = (async () => new Response(JSON.stringify({ stat: "fail", error: { message: "api_key is invalid." } }))) as unknown as typeof fetch;
    expect(await createExternalUptime({ apiKey: "k", fetchImpl: bad }).get()).toBeNull();
  });

  it("renders the independent values in the page itself, without third-party embeds", () => {
    const { store, pipeline } = buildTestApp({ fetchImpl: routedUpstream([]).impl }) as any;
    const html = renderStatusPage(buildStatus(store, pipeline), "de", { NAME: "X", BASE_URL: "https://x", CONTACT_EMAIL: "a@b.de", PAY_TO_ADDRESS: "0x1" }, {
      source: "UptimeRobot",
      status: "up",
      uptime_pct: { last_24h: 100, last_7d: 99.95, last_30d: 99.91 },
      checked_at: "2026-10-23T12:00:00Z",
    });
    expect(html).toContain("Unabhängige Prüfung (UptimeRobot)");
    expect(html).toContain("99.95 %");
    expect(html).toContain("erreichbar");
    expect(html).not.toMatch(/<iframe|<img[^>]+uptimerobot|<script/);
  });
});
