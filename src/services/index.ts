import { videoRecipes } from "./videoRecipes.js";
import { shootDayPlan } from "./shootPlan.js";
import { videoProjectPlan } from "./projectPlan.js";
import { shootLocationCheck } from "./shootLocationCheck.js";
import { contentMonthPlan } from "./contentMonthPlan.js";
import { contentPlanShift } from "./contentShift.js";
import { openDataSearch } from "./openDataSearch.js";
import { websiteCheck } from "./websiteCheck.js";
import { websiteContent, websiteChanges } from "./websiteContent.js";
import { regionalData } from "./regionalData.js";
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
import { localMarketCheck } from "./localMarketCheck.js";
import { keywordGap } from "./keywordGap.js";
import { keywordIdeas } from "./keywordIdeas.js";
import { keywordMetrics } from "./keywordMetrics.js";
import { domainOverview } from "./domainOverview.js";
import { keywordDifficulty } from "./keywordDifficulty.js";
import { rankedKeywords } from "./rankedKeywords.js";
import { searchIntent } from "./searchIntent.js";
import type { ServiceDefinition } from "./types.js";

/** All implemented services. Add a new adapter here and in src/config/services.ts. */
export const SERVICES: ServiceDefinition[] = [keywordMetrics, keywordIdeas, googleSerp, competitors, searchIntent, aiKeywordDemand, rankedKeywords, keywordDifficulty, domainOverview, keywordGap, googleTrends, localBusiness, bingSerp, pageAudit, domainTechnologies, keywordsForSite, trafficEstimate, newsSearch, imageSearch, localMarketCheck, websiteContent, websiteChanges, regionalData, websiteCheck, openDataSearch, contentMonthPlan, contentPlanShift, shootDayPlan, videoProjectPlan, videoRecipes, shootLocationCheck];

export function findService(id: string): ServiceDefinition | undefined {
  return SERVICES.find((s) => s.id === id);
}
