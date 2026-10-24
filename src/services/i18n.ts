import { z } from "zod";

/** Output languages of the content planning services. German stays the default for existing callers. */
export const LANGS = ["de", "en"] as const;
export type Lang = (typeof LANGS)[number];
export const languageInput = z.enum(LANGS).default("de").describe("de (default) or en");
/** Pick the text for the requested language. */
export const tr = (lang: Lang, de: string, en: string) => (lang === "en" ? en : de);
