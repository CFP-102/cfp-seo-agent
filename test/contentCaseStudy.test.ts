import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildContentCaseStudy } from "../scripts/build-content-case-study.js";
import { buildTestApp } from "./helpers.js";
import { routedUpstream, start, type Event } from "./x402helpers.js";
import { serviceConfig } from "../src/config/services.js";

describe("worked content example", () => {
  it("reproduces the published date-only snapshot with real local services, including conflicts", () => {
    const snapshot = JSON.parse(readFileSync(new URL("../public/examples/content-case-study.json", import.meta.url), "utf8"));
    expect(buildContentCaseStudy()).toEqual(snapshot);
    expect(snapshot.plan_excerpt.posts).toHaveLength(6);
    expect(snapshot.plan_excerpt.shoot_days).toHaveLength(2);
    expect(snapshot.plan_excerpt.conflicts_count).toBe(0);
    expect(snapshot.plan_excerpt.calendar_export_available).toBe(true);
    expect(snapshot.shift_excerpt.summary).toEqual({ posts_changed: 3, dates_changed: 7, errors: 1, warnings: 2 });
    expect(snapshot.shift_excerpt.needs_confirmation).toBe(true);
    expect(snapshot.paid).toBe(false);
    // This artifact must never expose the private recipe dataset through full plan results.
    expect(JSON.stringify(snapshot)).not.toMatch(/"(?:title|recipe_id|hook|ideas|shots|calendar_file_ics)"/);
  });

  it("serves both languages with current prices and no execution on page reads", async () => {
    const events: Event[] = [];
    const { app } = buildTestApp({ fetchImpl: routedUpstream(events).impl });
    const base = await start(app);
    const sum = Number(serviceConfig("content-month-plan").priceUsdc) + Number(serviceConfig("content-plan-shift").priceUsdc);
    for (const route of ["/content-planning-example", "/de/content-planung-beispiel"]) {
      const response = await fetch(base + route);
      const html = await response.text();
      expect(response.status).toBe(200);
      expect(html).not.toMatch(/\{\{[A-Z_]+\}\}/);
      expect(html).toContain(`${sum} USDC`);
      expect(html).toContain("needs_confirmation: true");
      expect(html).toContain("2026-10-29");
      expect(html).toContain("/examples/content-case-study.json");
    }
    const data = await (await fetch(base + "/examples/content-case-study.json")).json();
    expect(data).toMatchObject({ example_only: true, paid: false });
    expect(events).toEqual([]);
  });
});
