import { z } from "zod";
import { REGIONAL_LIMITS } from "../config/services.js";

export const regionalRecordSchema = z.strictObject({
  id: z.string().regex(/^Q[1-9]\d*$/), region: z.literal("chiemgau"),
  category: z.enum(["town", "nature", "attraction"]),
  name: z.string().min(1).max(200), description: z.string().max(1000),
  latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180),
  source_url: z.url().regex(/^https:\/\/www\.wikidata\.org\/wiki\/Q[1-9]\d*$/),
  source_revision: z.number().int().positive(), license: z.literal("CC0-1.0"),
  retrieved_at: z.iso.datetime(),
}).refine(r => r.source_url.endsWith("/" + r.id), "source URL must match record id");
export const regionalDatasetSchema = z.strictObject({
  dataset: z.literal("chiemgau-wikidata"), updated_at: z.iso.datetime(),
  records: z.array(regionalRecordSchema).min(1).max(REGIONAL_LIMITS.records),
}).refine(d => new Set(d.records.map(r => r.id)).size === d.records.length, "record IDs must be unique");
