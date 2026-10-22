import { aiKeywordDemand } from "./aiKeywordDemand.js";
import { competitors } from "./competitors.js";
import { googleSerp } from "./googleSerp.js";
import { keywordIdeas } from "./keywordIdeas.js";
import { keywordMetrics } from "./keywordMetrics.js";
import { domainOverview } from "./domainOverview.js";
import { keywordDifficulty } from "./keywordDifficulty.js";
import { rankedKeywords } from "./rankedKeywords.js";
import { searchIntent } from "./searchIntent.js";
import type { ServiceDefinition } from "./types.js";

/** All implemented services. Add a new adapter here and in src/config/services.ts. */
export const SERVICES: ServiceDefinition[] = [keywordMetrics, keywordIdeas, googleSerp, competitors, searchIntent, aiKeywordDemand, rankedKeywords, keywordDifficulty, domainOverview];

export function findService(id: string): ServiceDefinition | undefined {
  return SERVICES.find((s) => s.id === id);
}
