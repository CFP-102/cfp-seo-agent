/**
 * Adapter tests for all nineteen services. Fixtures are sandbox responses or explicitly
 * marked derived live fixtures — see _fixture_note in each file.
 */
import { describe, expect, it } from "vitest";
import { checkLocale, defaultLanguage } from "../src/config/locales.js";
import { DFS_PRICES, SERVICE_CONFIG } from "../src/config/services.js";
import { domainString, serpKeyword } from "../src/services/common.js";
import { SERVICES } from "../src/services/index.js";
import { aiKeywordDemand } from "../src/services/aiKeywordDemand.js";
import { competitors } from "../src/services/competitors.js";
import { googleSerp } from "../src/services/googleSerp.js";
import { keywordIdeas } from "../src/services/keywordIdeas.js";
import { searchIntent } from "../src/services/searchIntent.js";
import { domainOverview } from "../src/services/domainOverview.js";
import { keywordDifficulty } from "../src/services/keywordDifficulty.js";
import { rankedKeywords } from "../src/services/rankedKeywords.js";
import { bingSerp } from "../src/services/bingSerp.js";
import { domainTechnologies } from "../src/services/domainTechnologies.js";
import { googleTrends } from "../src/services/googleTrends.js";
import { keywordGap } from "../src/services/keywordGap.js";
import { localBusiness } from "../src/services/localBusiness.js";
import { pageAudit } from "../src/services/pageAudit.js";
import { imageSearch } from "../src/services/imageSearch.js";
import { keywordsForSite } from "../src/services/keywordsForSite.js";
import { newsSearch } from "../src/services/newsSearch.js";
import { trafficEstimate } from "../src/services/trafficEstimate.js";
import { fixture } from "./helpers.js";

const task = (name: string) => fixture(name).tasks[0];
const US = { location_code: 2840, language_code: "en" };

describe("registry", () => {
  it("has all services, matching config, unique ids and routes", () => {
    expect(SERVICES.map((s) => s.id).sort()).toEqual(Object.keys(SERVICE_CONFIG).sort());
    expect(new Set(SERVICES.map((s) => s.route)).size).toBe(SERVICES.length);
    for (const s of SERVICES) {
      expect(s.name.length, s.id).toBeLessThanOrEqual(32);
      expect(s.name, s.id).toMatch(/^[\x20-\x7e]+$/);
      expect(s.route).toBe(SERVICE_CONFIG[s.id]!.route);
      expect(s.priceUsdc).toBe(SERVICE_CONFIG[s.id]!.priceUsdc);
      expect(s.upstream.endpoint).toBe(SERVICE_CONFIG[s.id]!.dataforseoEndpoint);
    }
  });

  it("each service's own example input is valid, passes locale checks and builds exactly one upstream task", () => {
    for (const s of SERVICES) {
      const parsed = s.inputSchema.safeParse(s.example);
      expect(parsed.success, s.id).toBe(true);
      if (!parsed.success) continue;
      expect(s.validateInput?.(parsed.data) ?? null, s.id).toBeNull();
      expect(s.buildRequest(parsed.data), s.id).toHaveLength(1);
    }
  });

  it("worst-case upstream estimate at maximum input never exceeds the configured worst case (which prices were derived from)", () => {
    const kw = (n: number) => Array.from({ length: n }, (_, i) => `keyword ${i}`);
    const maxInputs: Record<string, unknown> = {
      "video-recipes": { category: "produkt" },
      "shoot-day-plan": { shoots: [{ title: "Example video" }] },
      "video-project-plan": { goal: "recruiting", shoot_date: "2026-11-20", deliver_by: "2026-12-23", today: "2026-10-24" },
      "content-month-plan": { from: "2026-11-02", to: "2026-11-27", today: "2026-10-24" },
      "content-plan-shift": { posts: [{ key: "p1", publish: "2026-11-13" }], move: { post_key: "p1", step: "publish", new_date: "2026-11-14" } },
      "shoot-location-check": { latitude: 47.867, longitude: 12.44, date: "2026-10-26" },
      "open-data-search": { source: "openbydata", query: "Chiemgau" },
      "website-check": { url: "https://example.com/", link_urls: ["https://example.com/about", "https://example.com/contact"] },
      "website-content": { url: "https://example.com/" },
      "website-changes": { url: "https://example.com/", previous: { url: "https://example.com/", text: "Old example." } },
      "regional-data": { region: "chiemgau" },
      "keyword-metrics": { keywords: kw(1000) },
      "keyword-ideas": { keywords: kw(1) },
      "google-serp": { keyword: "running shoes" },
      competitors: { domain: "example.com" },
      "search-intent": { keywords: kw(10) },
      "ai-keyword-demand": { keywords: kw(10) },
      "ranked-keywords": { domain: "example.com" },
      "keyword-difficulty": { keywords: kw(100) },
      "domain-overview": { domain: "example.com" },
      "keyword-gap": { domain: "example.com", competitor: "competitor.com" },
      "google-trends": { keywords: kw(5) },
      "local-business": { keyword: "coffee shop" },
      "bing-serp": { keyword: "running shoes" },
      "page-audit": { url: "https://example.com/" },
      "domain-technologies": { domain: "example.com" },
      "keywords-for-site": { domain: "example.com" },
      "traffic-estimate": { domains: Array.from({ length: 10 }, (_, i) => `site${i}.com`) },
      "news-search": { keyword: "electric cars" },
      "image-search": { keyword: "red bicycle" },
      "local-market-check": { keyword: "zahnarzt rosenheim", domain: "example.com" },
    };
    for (const s of SERVICES) {
      const parsed = s.inputSchema.parse(maxInputs[s.id]);
      const est = s.estimateCostUsd(parsed);
      expect(est, s.id).toBeLessThanOrEqual(SERVICE_CONFIG[s.id]!.worstCaseUsd + 1e-12);
      expect(est, s.id).toBeLessThanOrEqual(s.upstream.maxCostUsd);
    }
  });

  it("requests never ask DataForSEO for more than the configured result cap or for surcharged extras", () => {
    const ideas = keywordIdeas.buildRequest(keywordIdeas.inputSchema.parse({ keywords: ["a"] }))[0] as any;
    expect(ideas).toMatchObject({ limit: 25, include_clickstream_data: false, include_serp_info: false });
    const serp = googleSerp.buildRequest(googleSerp.inputSchema.parse({ keyword: "a" }))[0] as any;
    expect(serp).toMatchObject({ depth: 10, device: "desktop" });
    expect(Object.keys(serp).sort()).toEqual(["depth", "device", "keyword", "language_code", "location_code"]);
    const comp = competitors.buildRequest(competitors.inputSchema.parse({ domain: "example.com" }))[0] as any;
    expect(comp).toMatchObject({ limit: 10, include_clickstream_data: false });
  });
});

describe("keyword-ideas", () => {
  it("maps sandbox response, keeps nulls, caps at 25", () => {
    const out = keywordIdeas.mapResult(task("labs-keyword-suggestions.json"), keywordIdeas.inputSchema.parse({ keywords: ["running shoes"] }));
    expect(out.ideas.length).toBeGreaterThan(0);
    expect(out.ideas[0]).toMatchObject({ keyword: "sneaker running shoes", search_volume: 301000, cpc: 1.09, competition: 1, competition_level: "HIGH" });
    expect(out.total_available).toBeGreaterThanOrEqual(25);
    expect(out.seed_keywords).toEqual(["running shoes"]);
    const big = structuredClone(task("labs-keyword-suggestions.json"));
    big.result[0].items = Array.from({ length: 80 }, (_, i) => ({ keyword: `k${i}`, keyword_info: {} }));
    expect(keywordIdeas.mapResult(big, keywordIdeas.inputSchema.parse({ keywords: ["x"] })).ideas).toHaveLength(25);
  });
  it("uses the suggestions endpoint with one seed and rejects unsupported batches", () => {
    expect(keywordIdeas.upstream.endpoint).toBe("/v3/dataforseo_labs/google/keyword_suggestions/live");
    expect(keywordIdeas.buildRequest(keywordIdeas.inputSchema.parse({ keywords: ["running shoes"], ...US }))).toEqual([
      { keyword: "running shoes", ...US, limit: 25, include_serp_info: false, include_clickstream_data: false },
    ]);
    expect(keywordIdeas.inputSchema.safeParse({ keywords: ["a", "b"] }).success).toBe(false);
    expect(keywordIdeas.inputSchema.safeParse({ keywords: ["a"], limit: 700 }).success).toBe(false);
  });
});

describe("google-serp", () => {
  it("returns only organic results, ordered, capped at 10, with position/url/title/description", () => {
    const out = googleSerp.mapResult(task("serp-google-organic.json"), googleSerp.inputSchema.parse({ keyword: "pizza" }));
    expect(out.results.length).toBe(9);
    expect(out.results.every((r) => r.url && r.title)).toBe(true);
    expect(out.results.map((r) => r.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(out.results[0]).toMatchObject({ position: 1, absolute_position: 7, domain: "www.tripadvisor.co.uk" });
    expect(out.results[0]!.description).toContain("Best Pizza in London");
    expect(out.total_results_estimate).toBe(1120000000);
    // 25 organic items -> still at most 10
    const t = structuredClone(task("serp-google-organic.json"));
    const org = t.result[0].items.find((i: any) => i.type === "organic");
    t.result[0].items = Array.from({ length: 25 }, (_, n) => ({ ...org, rank_group: n + 1, rank_absolute: n + 1 }));
    expect(googleSerp.mapResult(t, googleSerp.inputSchema.parse({ keyword: "pizza" })).results).toHaveLength(10);
  });
  it("rejects search operators (they are billed at 5x)", () => {
    for (const k of ["site:example.com shoes", "intitle:shoes", '"exact phrase"', "shoes -cheap"]) {
      expect(serpKeyword.safeParse(k).success, k).toBe(false);
    }
    expect(serpKeyword.safeParse("e-commerce platforms").success).toBe(true);
  });
});

describe("competitors", () => {
  it("normalizes pasted URLs and rejects non-domains", () => {
    expect(domainString.parse("https://www.Example.com/some/page?x=1")).toBe("example.com");
    expect(domainString.parse("blog.example.co.uk")).toBe("blog.example.co.uk");
    for (const bad of ["localhost", "127.0.0.1", "example", "example.com:8080", "exa mple.com", "http://", "-bad.com", "a..com"]) {
      expect(domainString.safeParse(bad).success, bad).toBe(false);
    }
  });
  it("maps overlap and metrics, rounds averages, computes top3/top10", () => {
    const out = competitors.mapResult(task("labs-competitors-domain.json"), competitors.inputSchema.parse({ domain: "example.com" }));
    expect(out.competitors[0]).toMatchObject({ domain: "youtube.com", intersections: 115, avg_position: 13.84 });
    expect(out.competitors[0]!.domain_metrics.organic_keywords).toBe(151186715);
    expect(out.competitors[0]!.shared_keyword_metrics.top10_keywords).toBe(0);
    expect(out.total_available).toBe(993);
    expect(out.target).toBe("example.com");
  });
  it("tolerates missing metric blocks", () => {
    const t = structuredClone(task("labs-competitors-domain.json"));
    t.result[0].items = [{ domain: "bare.com", intersections: 5, avg_position: 3, full_domain_metrics: null, metrics: null }];
    const out = competitors.mapResult(t, competitors.inputSchema.parse({ domain: "example.com" }));
    expect(out.competitors[0]).toMatchObject({ domain: "bare.com", intersections: 5, avg_position: 3 });
    expect(out.competitors[0]!.domain_metrics).toMatchObject({ organic_keywords: null, paid_keywords: null });
    expect(out.competitors[0]!.shared_keyword_metrics.top3_keywords).toBeNull();
  });
});

describe("search-intent", () => {
  it("takes keywords only (no location/language), max 10", () => {
    expect(searchIntent.inputSchema.safeParse({ keywords: ["a"], language_code: "en" }).success).toBe(false);
    expect(searchIntent.inputSchema.safeParse({ keywords: Array.from({ length: 11 }, (_, i) => `k${i}`) }).success).toBe(false);
    expect(searchIntent.buildRequest(searchIntent.inputSchema.parse({ keywords: ["a", "b"] }))).toEqual([{ keywords: ["a", "b"] }]);
  });
  it("maps primary + secondary intents and lists unclassified keywords", () => {
    const out = searchIntent.mapResult(task("labs-search-intent.json"), searchIntent.inputSchema.parse({ keywords: ["transmitter", "never returned"] }));
    const t = out.keywords.find((k) => k.keyword === "transmitter")!;
    expect(t).toMatchObject({ intent: "transactional" });
    expect(t.secondary_intents).toEqual([{ label: "informational", probability: 0.3911 }]);
    expect(out.keywords.find((k) => k.keyword === "login page")).toMatchObject({ intent: "navigational", probability: 0.9999, secondary_intents: [] });
    expect(out.not_classified).toEqual(["never returned"]);
  });
});

describe("ai-keyword-demand", () => {
  it("labels every result as a modeled estimate with methodology", () => {
    const out = aiKeywordDemand.mapResult(task("ai-keyword-search-volume.json"), aiKeywordDemand.inputSchema.parse({ keywords: ["seo", "x"] }));
    expect(out.estimate).toBe(true);
    expect(out.methodology).toMatch(/estimate/i);
    expect(out.methodology).toMatch(/People Also Ask/);
    expect(aiKeywordDemand.notice).toBe(out.methodology);
    expect(out.keywords[0]).toMatchObject({ keyword: "seo", ai_search_volume: 117209 });
    expect(out.keywords[0]!.monthly_estimates).toHaveLength(12);
    expect(out.keywords[0]!.monthly_estimates[0]).toEqual({ year: 2026, month: 9, ai_search_volume: 117209 });
    expect(out.not_found).toEqual(["x"]);
  });
});

describe("location/language validation (refused before payment)", () => {
  it("defaults the language from the location", () => {
    expect(defaultLanguage(2840)).toBe("en");
    expect(defaultLanguage(2276)).toBe("de");
    expect(keywordIdeas.inputSchema.parse({ keywords: ["a"], location_code: 2276 })).toMatchObject({ location_code: 2276, language_code: "de" });
    expect(keywordIdeas.inputSchema.parse({ keywords: ["a"] })).toMatchObject(US);
  });
  it("labs/ai check exact pairs and name the available languages", () => {
    expect(checkLocale("labs", 2276, "de")).toBeNull();
    expect(checkLocale("labs", 2276, "en")).toMatch(/Available: de/);
    expect(checkLocale("ai", 2840, "en")).toBeNull();
    expect(checkLocale("labs", 99999, "en")).toMatch(/not supported/);
  });
  it("ads/serp check country code and language list", () => {
    expect(checkLocale("google_ads", 2276, "en")).toBeNull();
    expect(checkLocale("serp", 2276, "de")).toBeNull();
    expect(checkLocale("serp", 2276, "xx")).toMatch(/not supported/);
    expect(checkLocale("google_ads", 12345, "en")).toMatch(/not supported/);
  });
  it("services reject a pair their API family does not offer", () => {
    const parsed = competitors.inputSchema.parse({ domain: "example.com", location_code: 2276, language_code: "en" });
    expect(competitors.validateInput!(parsed)).toMatch(/Available: de/);
    const ok = googleSerp.inputSchema.parse({ keyword: "pizza", location_code: 2276, language_code: "en" });
    expect(googleSerp.validateInput!(ok)).toBeNull();
  });
});

describe("price list sanity", () => {
  it("DataForSEO price constants match the documented list (checked 2026-10-20)", () => {
    expect(DFS_PRICES).toEqual({
      googleAdsLivePerTask: 0.09,
      labsPerTask: 0.012,
      labsPerItem: 0.00012,
      serpLivePerPage: 0.002,
      aiKeywordPerTask: 0.01,
      aiKeywordPerItem: 0.0001,
      trendsLivePerTask: 0.011,
      mapsLivePer100: 0.002,
      bingLivePerPage: 0.002,
      instantPagesPerPage: 0.00015,
      domainTechPerTask: 0.012,
      newsLivePerPage: 0.002,
      imagesLivePerPage: 0.002,
    });
  });
});

describe("ranked-keywords, keyword-difficulty, domain-overview", () => {
  it("ranked-keywords maps position, url and metrics and caps the result count", () => {
    const i = rankedKeywords.inputSchema.parse({ domain: "example.com" });
    const out = rankedKeywords.mapResult(task("labs-ranked-keywords.json"), i);
    expect(out.keywords.length).toBeGreaterThan(0);
    expect(out.keywords.length).toBeLessThanOrEqual(25);
    expect(out.keywords[0]!.keyword).not.toBe("");
    const big = structuredClone(task("labs-ranked-keywords.json"));
    big.result[0].items = Array.from({ length: 60 }, () => structuredClone(task("labs-ranked-keywords.json").result[0].items[0]));
    expect(rankedKeywords.mapResult(big, i).keywords).toHaveLength(25);
    const req = rankedKeywords.buildRequest(i)[0] as any;
    expect(req.limit).toBe(25);
    expect(req.include_clickstream_data).toBe(false);
  });

  it("keyword-difficulty maps scores, reports missing keywords and bills per keyword", () => {
    const i = keywordDifficulty.inputSchema.parse({ keywords: ["a b", "never returned"] });
    const t = task("labs-bulk-keyword-difficulty.json");
    const out = keywordDifficulty.mapResult(t, i);
    expect(out.keywords.length).toBeGreaterThan(0);
    expect(out.not_found).toContain("never returned");
    expect(keywordDifficulty.estimateCostUsd(i)).toBeCloseTo(DFS_PRICES.labsPerTask + 2 * DFS_PRICES.labsPerItem, 10);
    expect(keywordDifficulty.inputSchema.safeParse({ keywords: Array.from({ length: 101 }, (_, n) => `k${n}`) }).success).toBe(false);
  });

  it("domain-overview maps organic and paid metrics", () => {
    const out = domainOverview.mapResult(task("labs-domain-rank-overview.json"), domainOverview.inputSchema.parse({ domain: "example.com" }));
    expect(out.organic.keywords_count).toEqual(expect.any(Number));
    expect(out.organic.positions.top_1).toEqual(expect.any(Number));
    expect(out.paid).toHaveProperty("traffic_cost_usd");
  });
});

describe("keyword-gap, google-trends, local-business, bing-serp, page-audit, domain-technologies", () => {
  it("keyword-gap sends the competitor as target1 with intersections=false and rejects identical domains", () => {
    const i = keywordGap.inputSchema.parse({ domain: "mine.com", competitor: "theirs.com" });
    const req = keywordGap.buildRequest(i)[0] as any;
    expect(req).toMatchObject({ target1: "theirs.com", target2: "mine.com", intersections: false, limit: 25, include_clickstream_data: false });
    expect(keywordGap.inputSchema.safeParse({ domain: "a.com", competitor: "www.a.com" }).success).toBe(false);
    const out = keywordGap.mapResult(task("labs-domain-intersection.json"), i);
    expect(out.keywords.length).toBeGreaterThan(0);
    expect(out.keywords[0]).toHaveProperty("competitor_position");
  });

  it("google-trends maps the graph and sends one task with at most 5 keywords", () => {
    const i = googleTrends.inputSchema.parse({ keywords: ["a", "b"] });
    expect((googleTrends.buildRequest(i)[0] as any).item_types).toEqual(["google_trends_graph"]);
    expect(googleTrends.inputSchema.safeParse({ keywords: ["a", "b", "c", "d", "e", "f"] }).success).toBe(false);
    const out = googleTrends.mapResult(task("keywords-google-trends.json"), i);
    expect(out.points.length).toBeGreaterThan(10);
    expect(out.points[0]!.values.length).toBeGreaterThan(0);
  });

  it("local-business and bing-serp map results, cap them and refuse search operators", () => {
    const lb = localBusiness.mapResult(task("serp-google-maps.json"), localBusiness.inputSchema.parse({ keyword: "pizza" }));
    expect(lb.businesses.length).toBe(20);
    expect(lb.businesses[0]!.name).toBeTruthy();
    expect(localBusiness.inputSchema.safeParse({ keyword: "site:example.com" }).success).toBe(false);
    const bing = bingSerp.mapResult(task("serp-bing-organic.json"), bingSerp.inputSchema.parse({ keyword: "pizza" }));
    expect(bing.results.length).toBeGreaterThan(0);
    expect(bing.results.length).toBeLessThanOrEqual(10);
    expect(bingSerp.inputSchema.safeParse({ keyword: '"pizza"' }).success).toBe(false);
    expect(bingSerp.validateInput?.({ keyword: "x", location_code: 2840, language_code: "en" })).toBeNull();
    expect(bingSerp.validateInput?.({ keyword: "x", location_code: 2840, language_code: "xx" })).not.toBeNull();
  });

  it("page-audit only accepts public http(s) page URLs and never asks for paid add-ons", () => {
    for (const bad of ["http://127.0.0.1/", "https://10.0.0.1/x", "https://localhost/", "ftp://example.com/", "https://user:pw@example.com/", "https://example.com:8080/", "javascript:alert(1)", "https://[::1]/"]) {
      expect(pageAudit.inputSchema.safeParse({ url: bad }).success, bad).toBe(false);
    }
    const i = pageAudit.inputSchema.parse({ url: "example.com/pricing#top" });
    expect(i.url).toBe("https://example.com/pricing");
    const req = pageAudit.buildRequest(i)[0] as any;
    expect(req).toMatchObject({ enable_javascript: false, load_resources: false, enable_browser_rendering: false });
    const out = pageAudit.mapResult(task("onpage-instant-pages.json"), i);
    expect(out.fetched).toBe(true);
    expect(out.http_status).toBe(200);
  });

  it("domain-technologies groups technologies and does not return contact details", () => {
    const out = domainTechnologies.mapResult(task("domain-technologies.json"), domainTechnologies.inputSchema.parse({ domain: "example.com" }));
    expect(out.found).toBe(true);
    expect(Object.keys(out.technologies).length).toBeGreaterThan(0);
    expect(JSON.stringify(out)).not.toMatch(/@|phone/);
  });
});

describe("keywords-for-site, traffic-estimate, news-search, image-search", () => {
  it("keywords-for-site maps keyword metrics and caps the count", () => {
    const i = keywordsForSite.inputSchema.parse({ domain: "example.com" });
    const out = keywordsForSite.mapResult(task("labs-keywords-for-site.json"), i);
    expect(out.keywords.length).toBeGreaterThan(0);
    expect(out.keywords[0]).toHaveProperty("search_volume");
    expect((keywordsForSite.buildRequest(i)[0] as any)).toMatchObject({ limit: 25, include_clickstream_data: false, include_serp_info: false });
  });

  it("traffic-estimate takes up to 10 domains, bills per domain and lists domains without data", () => {
    const i = trafficEstimate.inputSchema.parse({ domains: ["a.com", "www.a.com", "b.org", "never-returned.com"] });
    expect(i.domains).toEqual(["a.com", "b.org", "never-returned.com"]);
    expect(trafficEstimate.estimateCostUsd(i)).toBeCloseTo(DFS_PRICES.labsPerTask + 3 * DFS_PRICES.labsPerItem, 10);
    expect(trafficEstimate.inputSchema.safeParse({ domains: Array.from({ length: 11 }, (_, n) => `s${n}.com`) }).success).toBe(false);
    const out = trafficEstimate.mapResult(task("labs-bulk-traffic-estimation.json"), i);
    expect(out.domains.length).toBeGreaterThan(0);
    expect(out.not_found).toContain("never-returned.com");
  });

  it("news-search and image-search map only their own item types and refuse operators", () => {
    const news = newsSearch.mapResult(task("serp-google-news.json"), newsSearch.inputSchema.parse({ keyword: "pizza" }));
    expect(news.results.length).toBeGreaterThan(0);
    expect(news.results.length).toBeLessThanOrEqual(10);
    const img = imageSearch.mapResult(task("serp-google-images.json"), imageSearch.inputSchema.parse({ keyword: "pizza" }));
    expect(img.results.length).toBe(20);
    expect(img.results[0]!.image_url).toMatch(/^https?:/);
    expect(JSON.stringify(img)).not.toContain("encrypted-tbn");
    expect(newsSearch.inputSchema.safeParse({ keyword: "site:example.com" }).success).toBe(false);
    expect(imageSearch.inputSchema.safeParse({ keyword: '"x"' }).success).toBe(false);
  });
});

import { CONTENT_LIMITS } from "../src/config/services.js";
import { websiteContent, websiteChanges, compareText } from "../src/services/websiteContent.js";
import { regionalData } from "../src/services/regionalData.js";
import { regionalDatasetSchema } from "../src/services/regionalSchema.js";

describe("website extraction and changes", () => {
  const url = "https://example.com/";
  it("extracts documented main-topic structure and produces a reusable snapshot", () => {
    const out = websiteContent.mapResult(task("onpage-content-parsing.json"), { url });
    expect(out).toEqual(websiteContent.outputExample);
    const input = websiteChanges.inputSchema.parse({ url, previous: out.snapshot });
    const same = websiteChanges.mapResult(task("onpage-content-parsing.json"), input);
    expect(same).toMatchObject({ changed: false, added: { count: 0, lines: [] }, removed: { count: 0, lines: [] } });
    expect(websiteContent.buildRequest({ url })).toEqual([{ url, enable_javascript: false, enable_browser_rendering: false, load_resources: false, enable_xhr: false, store_raw_html: false, markdown_view: false }]);
  });
  it("counts added and removed repeated lines and detects reordered text", () => {
    expect(compareText("A\nA\nB", "A\nC")).toEqual({ added: { count: 1, lines: ["C"] }, removed: { count: 2, lines: ["A", "B"] } });
    expect(compareText("A\nB", "B\nA").added.count).toBe(0);
    const out = websiteChanges.mapResult(task("onpage-content-parsing.json"), websiteChanges.inputSchema.parse(websiteChanges.example));
    expect(out.changed).toBe(true);
    expect(out.removed.lines).toEqual(["Old example."]);
    expect(websiteChanges.cacheTtlSeconds).toBe(0);
  });
  it("bounds content and marks incomplete output, without retaining navigation", () => {
    const t = structuredClone(task("onpage-content-parsing.json"));
    const pc = t.result[0].items[0].page_content;
    pc.header = { primary_content: [{ text: "NAVIGATION SECRET" }] };
    pc.main_topic = Array.from({ length: 80 }, (_, n) => ({ main_title: `Title ${n}`, level: 2, primary_content: [{ text: "x".repeat(2000), urls: [{ url: `https://example.com/page${n}`, anchor_text: "A" }] }] }));
    const out = websiteContent.mapResult(t, { url });
    expect(out.text.length).toBeLessThanOrEqual(CONTENT_LIMITS.textChars);
    expect(out.text).not.toContain("NAVIGATION SECRET");
    expect(out.truncated).toBe(true);
    expect(out.headings).toHaveLength(CONTENT_LIMITS.headings);
    expect(out.links).toHaveLength(CONTENT_LIMITS.links);
    expect(websiteChanges.inputSchema.safeParse({ url, previous: out.snapshot }).success).toBe(true);
    const changes = compareText("", Array.from({ length: 80 }, (_, n) => `Line ${n}`).join("\n"));
    expect(changes.added.count).toBe(80);
    expect(changes.added.lines).toHaveLength(CONTENT_LIMITS.changes);
  });
  it("does not present missing or failed pages as a successful comparison", () => {
    for (const status of [0, 301, 403, 404, 500]) {
      const t = structuredClone(task("onpage-content-parsing.json")); t.result[0].items[0].status_code = status;
      expect(() => websiteContent.mapResult(t, { url })).toThrow("could not be fetched");
    }
    const t = structuredClone(task("onpage-content-parsing.json")); t.result[0].items[0].page_content.main_topic = [];
    expect(() => websiteContent.mapResult(t, { url })).toThrow("No main-topic text");
  });
});

describe("Chiemgau local dataset", () => {
  it("filters real source records and retains provenance on every result", () => {
    const all = regionalData.executeLocal!({ region: "chiemgau" });
    expect(all.places).toHaveLength(8);
    expect(all.coverage).toContain("not a complete directory");
    for (const place of all.places) expect(place).toMatchObject({ license: "CC0-1.0", source_revision: expect.any(Number), source_url: `https://www.wikidata.org/wiki/${place.id}`, retrieved_at: expect.any(String) });
    expect(regionalData.executeLocal!({ region: "chiemgau", query: "fraueninsel" }).places[0]?.id).toBe("Q645925");
    expect(regionalData.executeLocal!({ region: "chiemgau", category: "town" }).places).toHaveLength(3);
    expect(regionalData.executeLocal!({ region: "chiemgau", query: "nonexistent-place" })).toMatchObject({ places: [], total_matches: 0 });
    expect(regionalData.inputSchema.safeParse({ region: "bayern" }).success).toBe(false);
  });
  it("rejects empty or unlicensed datasets and mismatched source identities", () => {
    const valid = { dataset: "chiemgau-wikidata", updated_at: new Date().toISOString(), records: regionalData.outputExample.places };
    expect(regionalDatasetSchema.safeParse(valid).success).toBe(true);
    expect(regionalDatasetSchema.safeParse({ ...valid, records: [] }).success).toBe(false);
    expect(regionalDatasetSchema.safeParse({ ...valid, records: [{ ...valid.records[0], license: "unknown" }] }).success).toBe(false);
    expect(regionalDatasetSchema.safeParse({ ...valid, records: [{ ...valid.records[0], source_url: "https://www.wikidata.org/wiki/Q1" }] }).success).toBe(false);
  });
});

import { createWebsiteCheck, sitemapFormat, websiteCheck } from "../src/services/websiteCheck.js";
import type { ProbeResult } from "../src/lib/webProbe.js";

describe("technical website-check package", () => {
  const probes = () => fixture("website-check.json").tasks[0].result[0].probes as ProbeResult[];
  it("requires exactly two distinct same-origin HTTPS links", () => {
    expect(websiteCheck.inputSchema.safeParse(websiteCheck.example).success).toBe(true);
    for (const input of [
      { ...websiteCheck.example, url: "http://example.com/" },
      { ...websiteCheck.example, link_urls: ["https://example.com/about"] },
      { ...websiteCheck.example, link_urls: ["https://evil.com/a", "https://example.com/b"] },
      { ...websiteCheck.example, link_urls: ["https://example.com/about", "https://example.com/about"] },
      { ...websiteCheck.example, link_urls: ["https://example.com/sitemap.xml", "https://example.com/about"] },
    ]) expect(websiteCheck.inputSchema.safeParse(input).success).toBe(false);
  });
  it("executes exactly four fixed probes and classifies link responses without fallback requests", async () => {
    const calls: { url: string; method: string }[] = [];
    const values = probes(); values[2]!.status = 404; values[3]!.status = 405;
    const service = createWebsiteCheck(async (url, method) => { calls.push({ url, method }); return values[calls.length - 1]!; });
    const result = await service.executeRemote!(service.example, "live");
    expect(calls).toEqual([
      { url: "https://example.com/", method: "HEAD" }, { url: "https://example.com/sitemap.xml", method: "GET" },
      { url: "https://example.com/about", method: "HEAD" }, { url: "https://example.com/contact", method: "HEAD" },
    ]);
    expect(result.simulated).toBe(false);
    expect(result.broken_links_count).toBe(1);
    expect(result.links.map(x => x.state)).toEqual(["broken", "head_not_supported"]);
    expect(result.sitemap.format).toBe("urlset");
    expect(JSON.stringify(result)).not.toContain('"body":');
    const redirected = probes(); redirected[2]!.status = 302; redirected[2]!.redirect_url = "https://example.com/next";
    expect(service.mapResult({ ...fixture("website-check.json").tasks[0], result: [{ probes: redirected }] }, service.example).links[0]?.state).toBe("redirect");
  });
  it("never probes targets in sandbox mode and clearly marks simulated TLS checks", async () => {
    const service = createWebsiteCheck(async () => { throw new Error("must not call"); });
    expect(await service.executeRemote!(service.example, "sandbox")).toEqual(service.outputExample);
    expect(service.outputExample.simulated).toBe(true);
  });
  it("recognizes the sitemap container without executing DTDs or claiming XML validity", () => {
    expect(sitemapFormat('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"/>')).toBe("urlset");
    expect(sitemapFormat('<?xml version="1.0"?><!-- comment --><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></sitemapindex>')).toBe("sitemapindex");
    for (const bad of ["<html>Not a sitemap</html>", "<urlset>no namespace</urlset>", '<!DOCTYPE urlset [<!ENTITY x SYSTEM "file:///etc/passwd">]><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']) expect(sitemapFormat(bad)).toBeNull();
  });
});

import { buildCatalogUrl, mapCatalog, openDataSearch } from "../src/services/openDataSearch.js";

describe("public open-data catalogs", () => {
  it("uses the supplied hub-search API and CKAN endpoint with fixed result limits and literal terms", () => {
    for (const source of ["govdata", "openbydata"] as const) {
      const u = buildCatalogUrl({ source, query: "Parkplätze Rosenheim" });
      expect(u.searchParams.get("q")).toBe('"Parkplätze" AND "Rosenheim"');
      expect(u.origin).toBe(source === "govdata" ? "https://ckan.govdata.de" : "https://open.bydata.de");
      expect(u.searchParams.get(source === "govdata" ? "rows" : "limit")).toBe("10");
    }
    for (const query of ["*:*", "title:private", '"x"', "x&limit=1000", "x\ny", "..", "a".repeat(81)]) expect(openDataSearch.inputSchema.safeParse({ source: "govdata", query }).success).toBe(false);
    expect(openDataSearch.inputSchema.safeParse({ source: "elsewhere", query: "test" }).success).toBe(false);
  });
  it("retains resource licenses when CKAN's top-level license is empty and separates dates", () => {
    const data = { success: true, result: { count: 1, results: [{ id: "sample", title: "Parking", license_id: "", metadata_modified: "2026-10-23", organization: { title: "Aggregator" }, extras: [{ key: "uri", value: "https://open.bydata.de/api/hub/repo/datasets/sample" }, { key: "modified", value: "2025-01-01" }, { key: "publisher_name", value: "Source authority" }], resources: [{ url: "https://example.com/data.csv", format: "CSV", license: "http://dcat-ap.de/def/licenses/cc-by/4.0" }] }] } };
    const r = mapCatalog(data, { source: "govdata", query: "parking" }, "2026-10-24T00:00:00Z", false);
    expect(r.datasets[0]).toMatchObject({ publisher: "Source authority", dataset_license_reference: null, dataset_modified: "2025-01-01", metadata_modified: "2026-10-23", reuse_review_required: true, resources: [{ license_reference: "http://dcat-ap.de/def/licenses/cc-by/4.0" }] });
    expect(r.datasets[0]?.deduplication_key).toMatch(/^[a-f0-9]{64}$/);
    const hub = { result: { count: 1, results: [{ id: "sample", title: { de: "Parking" }, resource: "https://open.bydata.de/api/hub/repo/datasets/sample", distributions: [] }] } };
    expect(mapCatalog(hub, { source: "openbydata", query: "parking" }, "now", false).datasets[0]?.deduplication_key).toBe(r.datasets[0]?.deduplication_key);
    const first = structuredClone(data), second = structuredClone(data);
    first.result.results[0]!.extras[0]!.value += "#first"; second.result.results[0]!.extras[0]!.value += "#second";
    expect(mapCatalog(first, { source: "govdata", query: "parking" }, "now", false).datasets[0]?.deduplication_key).not.toBe(mapCatalog(second, { source: "govdata", query: "parking" }, "now", false).datasets[0]?.deduplication_key);
  });
  it("caps datasets, descriptions, resources and URLs; refuses malformed success responses", () => {
    const item = { id: "sample", title: "A", notes: "x".repeat(2000), resources: Array.from({ length: 20 }, () => ({ url: "https://example.com/data.csv" })) };
    const r = mapCatalog({ success: true, result: { count: 100, results: Array.from({ length: 30 }, () => item) } }, { source: "govdata", query: "parking" }, "now", false);
    expect(r.datasets).toHaveLength(10); expect(r.truncated).toBe(true);
    expect(r.datasets[0]?.description?.length).toBe(500);
    expect(r.datasets[0]?.resources).toHaveLength(3); expect(r.datasets[0]?.resources_truncated).toBe(true);
    for (const payload of [{ success: false, result: { count: 0, results: [] } }, { success: true, result: { count: -1, results: [] } }, { success: true, result: { count: 1, results: [{}] } }]) expect(() => mapCatalog(payload, { source: "govdata", query: "parking" }, "now", false)).toThrow();
  });
});
