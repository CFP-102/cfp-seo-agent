import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { contentMonthPlan } from "../src/services/contentMonthPlan.js";
import { contentPlanShift } from "../src/services/contentShift.js";

/** Offline documentation snapshot. Never copy recipe titles, IDs, ideas or complete calendars. */
export function buildContentCaseStudy() {
  const planInput = {
    from: "2026-11-02", to: "2026-11-27", today: "2026-10-24",
    mix_counts: { produkt: 2, mitarbeiter: 2, bts: 2 }, language: "de" as const,
  };
  const parsedPlan = contentMonthPlan.inputSchema.parse(planInput);
  const planError = contentMonthPlan.validateInput?.(parsedPlan);
  if (planError) throw new Error(planError);
  const plan = contentMonthPlan.executeLocal!(parsedPlan);
  const posts = plan.posts_for_reschedule.map(p => ({
    key: p.key, concept: p.concept, shoot: p.shoot, edit: p.edit, review: p.review,
    publish: p.publish, shoot_group: p.shoot_group,
  }));
  const shiftInput = {
    posts, language: "de" as const,
    move: { post_key: "p1", step: "shoot" as const, new_date: "2026-11-06", shoot_mode: "group" as const },
  };
  const parsedShift = contentPlanShift.inputSchema.parse(shiftInput);
  const shiftError = contentPlanShift.validateInput?.(parsedShift);
  if (shiftError) throw new Error(shiftError);
  const shifted = contentPlanShift.executeLocal!(parsedShift);
  return {
    example_only: true, paid: false, execution: "offline_local_functions",
    note: "Fixed reference-date demonstration. Not a customer result or proof of payment. Recipe content omitted; posts use keys only. Replace dates before a new request.",
    plan_input: planInput,
    plan_excerpt: {
      posts, shoot_days: plan.shoot_days.map(d => ({ key: d.key, date: d.date, post_keys: d.post_keys })),
      conflicts_count: plan.conflicts.length, warnings_count: plan.warnings.length,
      calendar_export_available: plan.calendar_file_ics.startsWith("BEGIN:VCALENDAR\r\n"),
    },
    shift_input: shiftInput,
    shift_excerpt: {
      posts: shifted.posts, changes: shifted.changes, conflicts: shifted.conflicts, blocked: shifted.blocked,
      summary: shifted.summary, needs_confirmation: shifted.needs_confirmation,
    },
  };
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function writeContentCaseStudy() {
  const snapshot = buildContentCaseStudy();
  writeFileSync(new URL("../public/examples/content-case-study.json", import.meta.url), JSON.stringify(snapshot, null, 2) + "\n");
  for (const lang of ["en", "de"]) {
    const de = lang === "de";
    const table = (headers: string[], rows: string[][]) => `<div class="tablewrap"><table><thead><tr>${headers.map(h => `<th scope="col">${escapeHtml(h)}</th>`).join("")}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
    const phase = (s: string) => de ? ({ concept: "Konzept", shoot: "Dreh", edit: "Schnitt", review: "Freigabe", publish: "Veröffentlichung" }[s] ?? s) : s;
    const sections: Record<string, string> = {
      INPUT: `<pre><code>${escapeHtml(JSON.stringify(snapshot.plan_input, null, 2))}</code></pre>`,
      PLAN: table(de ? ["Beitrag", "Konzept", "Dreh", "Schnitt", "Freigabe", "Veröffentlichung", "Drehgruppe"] : ["Post", "Concept", "Shoot", "Edit", "Review", "Publish", "Shoot group"], snapshot.plan_excerpt.posts.map(p => [p.key, p.concept ?? "—", p.shoot ?? "—", p.edit ?? "—", p.review ?? "—", p.publish, p.shoot_group ?? "—"])),
      MOVE: `<pre><code>${escapeHtml(JSON.stringify(snapshot.shift_input.move, null, 2))}</code></pre>`,
      CHANGES: table(de ? ["Beitrag", "Schritt", "Vorher", "Nachher"] : ["Post", "Step", "Before", "After"], snapshot.shift_excerpt.changes.map(c => [c.post_key, phase(c.step), c.from ?? "—", c.to])),
    };
    const url = new URL(`../public/case-study-${lang}.html`, import.meta.url);
    let html = readFileSync(url, "utf8");
    for (const [name, content] of Object.entries(sections)) {
      const pattern = new RegExp(`<!-- CASE_${name}_START -->[\\s\\S]*?<!-- CASE_${name}_END -->`);
      if (!pattern.test(html)) throw new Error(`Missing case-study section ${name}`);
      html = html.replace(pattern, () => `<!-- CASE_${name}_START -->${content}<!-- CASE_${name}_END -->`);
    }
    writeFileSync(url, html);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) writeContentCaseStudy();
