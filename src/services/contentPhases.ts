import { addDays, diffDays } from "./dates.js";
import { tr, type Lang } from "./i18n.js";

/**
 * Linked production dates of one post: concept -> shoot -> edit -> review -> publish. Ported from the operator's
 * Content Kalender 2.0 (dependency checks and propagation). Completed steps are never moved automatically.
 */
export const STEPS = ["concept", "shoot", "edit", "review"] as const;
export const CHAIN = [...STEPS, "publish"] as const;
export type Step = (typeof CHAIN)[number];
export const LABEL_DE: Record<Step, string> = { concept: "Konzept", shoot: "Dreh", edit: "Schnitt", review: "Freigabe", publish: "Veröffentlichung" };
export const LABEL_EN: Record<Step, string> = { concept: "Concept", shoot: "Shoot", edit: "Edit", review: "Review", publish: "Publish" };
export const labelOf = (lang: Lang, step: Step) => (lang === "en" ? LABEL_EN : LABEL_DE)[step];
/** Minimum days from a step to the NEXT step. */
export const MIN_GAP: Record<Step, number> = { concept: 0, shoot: 1, edit: 0, review: 0, publish: 0 };
export type Dates = Partial<Record<Step, string>>;
export interface Conflict { level: "error" | "warn"; steps: Step[]; message: string }

export function validateDates(dates: Dates, lang: Lang = "de"): Conflict[] {
  const L = (s: Step) => labelOf(lang, s);
  const out: Conflict[] = [];
  const present = CHAIN.filter(k => dates[k]);
  for (let i = 1; i < present.length; i++) {
    const a = present[i - 1]!, b = present[i]!;
    let need = 0;
    for (let j = CHAIN.indexOf(a); j < CHAIN.indexOf(b); j++) need += MIN_GAP[CHAIN[j]!];
    const diff = diffDays(dates[a]!, dates[b]!);
    if (diff < 0) out.push({ level: "error", steps: [a, b], message: tr(lang, `${L(b)} (${dates[b]}) liegt vor ${L(a)} (${dates[a]}).`, `${L(b)} (${dates[b]}) is before ${L(a)} (${dates[a]}).`) });
    else if (diff < need) out.push({ level: "warn", steps: [a, b], message: tr(lang, `${L(a)} und ${L(b)} liegen zu dicht beieinander (${diff} ${diff === 1 ? "Tag" : "Tage"}).`, `${L(a)} and ${L(b)} are too close together (${diff} ${diff === 1 ? "day" : "days"}).`) });
  }
  if (dates.shoot && dates.publish) {
    const lead = diffDays(dates.shoot, dates.publish);
    if (lead === 1) out.push({ level: "warn", steps: ["shoot", "publish"], message: tr(lang, "Der Drehtag liegt nur einen Tag vor der geplanten Veröffentlichung. Der Schnitt könnte zu knapp werden.", "The shoot is only one day before publishing. Editing may get tight.") });
    else if (lead === 0) out.push({ level: "warn", steps: ["shoot", "publish"], message: tr(lang, "Dreh und Veröffentlichung am selben Tag – für Schnitt und Freigabe bleibt keine Zeit.", "Shoot and publish on the same day: no time left for editing and review.") });
  }
  return out;
}

/** Make the chain consistent from a changed step on, forwards and backwards. Done steps stay put and are reported as blocked. */
export function propagate(dates: Dates, done: ReadonlySet<Step>, changed: Step, blocked: Step[]): void {
  const idx = CHAIN.indexOf(changed);
  let prev: Step = changed;
  for (let i = idx + 1; i < CHAIN.length - 1; i++) {
    const k = CHAIN[i]!; if (!dates[k]) continue;
    let need = 0; for (let j = CHAIN.indexOf(prev); j < i; j++) need += MIN_GAP[CHAIN[j]!];
    const min = addDays(dates[prev]!, need);
    if (dates[k]! < min) {
      if (done.has(k)) blocked.push(k);
      else dates[k] = dates.publish && min > dates.publish ? dates.publish : min;
    }
    prev = k;
  }
  let next: Step = changed;
  for (let i = idx - 1; i >= 0; i--) {
    const k = CHAIN[i]!; if (!dates[k]) continue;
    let need = 0; for (let j = i; j < CHAIN.indexOf(next); j++) need += MIN_GAP[CHAIN[j]!];
    const max = addDays(dates[next]!, -need);
    if (dates[k]! > max) {
      if (done.has(k)) blocked.push(k);
      else dates[k] = max;
    }
    next = k;
  }
}
