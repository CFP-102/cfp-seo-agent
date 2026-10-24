import { z } from "zod";
import raw from "../config/video-recipes.json" with { type: "json" };
import { PLAN_LIMITS, serviceConfig } from "../config/services.js";
import { compactExample } from "./exampleCompact.js";
import type { ServiceDefinition } from "./types.js";

const cfg = serviceConfig("video-recipes");
const text = (max: number) => z.string().min(1).max(max);
const variantSchema = z.strictObject({ type: text(30), label: text(120), count: z.number().int().min(1).max(10), mediaType: z.enum(["reel", "video", "post", "story", "carousel"]) });
export const recipeSchema = z.strictObject({
  id: z.string().regex(/^tpl-[a-z0-9-]{1,60}$/), title: text(120), category: text(30), description: text(400),
  length: text(30), mediaType: z.enum(["reel", "video"]), hook: text(300), hookAlternatives: z.array(text(300)).max(6),
  shots: z.array(text(300)).max(20), questions: z.array(text(300)).max(12), equipment: z.array(text(80)).max(12),
  shootMinutes: z.number().int().min(5).max(240), effortLabel: text(60), platforms: z.array(text(40)).max(8),
  locationHint: text(80), peopleHint: text(120), setup: z.enum(["interview", "screen", "detail", "mixed", "broll"]),
  tips: z.array(text(300)).max(8), variants: z.array(variantSchema).max(6), ideas: z.array(text(200)).max(10),
});
const datasetSchema = z.strictObject({
  dataset: z.literal("chiemgau-films-video-recipes"), updated_at: z.iso.datetime(), license: text(200),
  /** True for the small public sample file; the operator's full recipe set is not part of the public repository. */
  sample: z.boolean().optional(),
  categories: z.array(z.strictObject({ id: text(30), label: text(60), description: text(200) })).min(1).max(12),
  recipes: z.array(recipeSchema).min(1).max(100),
}).refine(d => new Set(d.recipes.map(r => r.id)).size === d.recipes.length, "recipe ids must be unique")
  .refine(d => d.recipes.every(r => d.categories.some(c => c.id === r.category)), "every recipe needs a known category");
export const recipeDataset = datasetSchema.parse(raw);

const categoryIds = recipeDataset.categories.map(c => c.id) as [string, ...string[]];
const inputSchema = z.strictObject({
  recipe_id: z.string().regex(/^tpl-[a-z0-9-]{1,60}$/).optional().describe("Exact recipe id from the index, e.g. tpl-produkt-in-30-sekunden. Returns that one recipe."),
  category: z.enum(categoryIds).optional().describe("Recipe category: produkt, mitarbeiter, bts, wissen, kunde, unternehmen or recruiting."),
  query: z.string().trim().min(1).max(PLAN_LIMITS.queryChars).optional().describe("Plain words matched against title, description and ideas."),
});
type Input = z.output<typeof inputSchema>;
const fold = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();

function run(i: Input) {
  const byId = i.recipe_id ? recipeDataset.recipes.filter(r => r.id === i.recipe_id) : recipeDataset.recipes;
  const terms = i.query ? fold(i.query).split(/\s+/u).filter(Boolean) : [];
  const matches = byId.filter(r => (!i.category || r.category === i.category)
    && terms.every(t => fold(`${r.title} ${r.description} ${r.ideas.join(" ")}`).includes(t)));
  return {
    dataset: recipeDataset.dataset, dataset_updated_at: recipeDataset.updated_at, language: "de",
    total_matches: matches.length, truncated: matches.length > cfg.maxResults,
    recipes: matches.slice(0, cfg.maxResults),
    index: recipeDataset.recipes.map(r => ({ id: r.id, title: r.title, category: r.category, media_type: r.mediaType, shoot_minutes: r.shootMinutes })),
    categories: recipeDataset.categories,
    coverage: `${recipeDataset.recipes.length} hand-written recipes for short company videos (product, team, behind the scenes, tips, customers, company, recruiting). Not a screenplay generator, no AI model, no legal clearance for filming people or locations.`,
  };
}

export const videoRecipes: ServiceDefinition<Input, ReturnType<typeof run>> = {
  id: cfg.id, name: cfg.name, route: cfg.route, priceUsdc: cfg.priceUsdc, enabled: cfg.enabled,
  cacheTtlSeconds: cfg.cacheTtlSeconds, limits: { maxInputs: cfg.maxInputs, maxResults: cfg.maxResults },
  upstream: { endpoint: cfg.dataforseoEndpoint, maxCostUsd: cfg.maxUpstreamCostUsd },
  summary: "Get ready-made video recipes with hook, shot list, interview questions, equipment, recording time, platforms and follow-up formats (one shoot, several posts). Filter by category, words or exact recipe id. Content is German; the response also lists all recipe ids.",
  notice: "Operator-written content, not generated per call. Recipes are suggestions: get consent before filming people and clear locations and rights yourself. The payment buys the lookup; no personal data is processed.",
  inputSchema, estimateCostUsd: () => 0,
  buildRequest: i => [i], mapResult: (_task, i) => run(i), executeLocal: run,
  example: { category: "produkt" }, outputExample: compactExample(run({ recipe_id: "tpl-kurzer-experten-tipp" }), 1, 60),
};
