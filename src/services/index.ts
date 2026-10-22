import { aiKeywordDemand } from "./aiKeywordDemand.js";
import { competitors } from "./competitors.js";
import { googleSerp } from "./googleSerp.js";
import { bingSerp } from "./bingSerp.js";
import { domainTechnologies } from "./domainTechnologies.js";
import { googleTrends } from "./googleTrends.js";
import { localBusiness } from "./localBusiness.js";
import { pageAudit } from "./pageAudit.js";
import { imageSearch } from "./imageSearch.js";
import { keywordsForSite } from "./keywordsForSite.js";
import { newsSearch } from "./newsSearch.js";
import { trafficEstimate } from "./trafficEstimate.js";
import { keywordGap } from "./keywordGap.js";
import { keywordIdeas } from "./keywordIdeas.js";
import { keywordMetrics } from "./keywordMetrics.js";
import { domainOverview } from "./domainOverview.js";
import { keywordDifficulty } from "./keywordDifficulty.js";
import { rankedKeywords } from "./rankedKeywords.js";
import { searchIntent } from "./searchIntent.js";
import type { ServiceDefinition } from "./types.js";

/** All implemented services. Add a new adapter here and in src/config/services.ts. */
export const SERVICES: ServiceDefinition[] = [keywordMetrics, keywordIdeas, googleSerp, competitors, searchIntent, aiKeywordDemand, rankedKeywords, keywordDifficulty, domainOverview, keywordGap, googleTrends, localBusiness, bingSerp, pageAudit, domainTechnologies, keywordsForSite, trafficEstimate, newsSearch, imageSearch];

export function findService(id: string): ServiceDefinition | undefined {
  return SERVICES.find((s) => s.id === id);
}
