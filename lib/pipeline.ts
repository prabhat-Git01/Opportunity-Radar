import { TRUSTED_SOURCES, OpportunityCategory, TrustedSource } from "@/config/sources";
import {
  FetchedPageContent,
  Opportunity,
  PipelineProgressEvent,
  SearchResultItem,
  SourceReport,
  TriagedUrl,
  UnderstandingResult,
  UserProfileInput,
} from "./types";
import { tinyfishFetch, tinyfishSearch } from "./tinyfish";
import { geminiExtractAndMatch, geminiTriage, geminiUnderstand } from "./gemini";

/**
 * Concurrency runner helper: runs an array of async tasks with max concurrency
 */
async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let currentIndex = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (currentIndex < items.length) {
      const idx = currentIndex++;
      try {
        results[idx] = await fn(items[idx], idx);
      } catch (err) {
        console.error(`[Concurrency Error] Task ${idx} failed:`, err);
      }
    }
  });

  await Promise.all(workers);
  return results;
}

/**
 * Helper to slugify a keyword for Internshala URLs (e.g. "machine learning" -> "machine-learning")
 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Helper to extract domain from URL
 */
function getDomain(urlStr: string): string {
  try {
    const parsed = new URL(urlStr);
    return parsed.hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * Normalize string for deduplication
 */
function normalizeKey(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export async function runOpportunityPipeline(
  input: UserProfileInput,
  onProgress: (event: PipelineProgressEvent) => void
): Promise<{ opportunities: Opportunity[]; sources: SourceReport[] }> {
  const today = new Date();
  const todayDate = today.toISOString().slice(0, 10);
  const sixtyDaysAgoDate = new Date(today.getTime() - 60 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  console.log(`\n==================================================`);
  console.log(`[Pipeline Start] Opportunity Radar run at ${todayDate}`);
  console.log(`[Input] Looking for: "${input.lookingFor}"`);
  console.log(`[Input] Profile: "${input.profile}"`);
  console.log(`[Input] Selected categories: ${input.selectedCategories?.join(", ") || "All"}`);
  console.log(`==================================================\n`);

  // ==========================================
  // STEP 1 - UNDERSTAND (Gemini)
  // ==========================================
  onProgress({
    stage: "understanding",
    message: "Analyzing your profile and goal with Gemini...",
    stepIndex: 1,
  });

  const understanding: UnderstandingResult = await geminiUnderstand(
    input.lookingFor,
    input.profile,
    todayDate,
    input.selectedCategories
  );

  onProgress({
    stage: "keywords",
    message: `Identified key areas: ${understanding.keywords.join(", ")}`,
    stepIndex: 1,
    data: {
      keywords: understanding.keywords,
      understanding,
    },
  });

  // Determine active categories
  let activeCategories = understanding.categories;
  if (
    input.selectedCategories &&
    input.selectedCategories.length > 0 &&
    !input.selectedCategories.includes("All")
  ) {
    activeCategories = input.selectedCategories as OpportunityCategory[];
  }

  const relevantSources = TRUSTED_SOURCES.filter((s) =>
    activeCategories.includes(s.category)
  );
  const relevantDomains = Array.from(new Set(relevantSources.map((s) => s.domain)));

  console.log(`[Pipeline Step 1 Done] Active categories (${activeCategories.length}):`, activeCategories);
  console.log(`[Pipeline Step 1 Done] Relevant trusted sources (${relevantSources.length}) domains:`, relevantDomains);

  // ==========================================
  // STEP 2 - GATHER (A and B in parallel)
  // ==========================================
  onProgress({
    stage: "searching",
    message: `Searching ${relevantSources.length} trusted sources and the open web...`,
    stepIndex: 2,
  });

  // A) Keyword searches on trusted sites + 1 open-web search
  const searchPromise = (async () => {
    const allSearchItems: SearchResultItem[] = [];

    // Run 5 queries with include_domains
    const queryTasks = understanding.search_queries.map((q) => async () => {
      try {
        const results = await tinyfishSearch({
          query: q,
          location: "IN",
          language: "en",
          afterDate: sixtyDaysAgoDate,
          includeDomains: relevantDomains.length > 0 ? relevantDomains : undefined,
        });
        return results;
      } catch (err: any) {
        console.warn(`[Search] Query failed for "${q}":`, err.message);
        return [];
      }
    });

    // Plus ONE extra open-web search with the best query
    const openWebTask = async () => {
      const bestQuery = understanding.search_queries[0] || `${understanding.keywords[0]} opportunity India 2026`;
      try {
        const results = await tinyfishSearch({
          query: bestQuery,
          location: "IN",
          language: "en",
          afterDate: sixtyDaysAgoDate,
          excludeDomains: [
            "instagram.com",
            "facebook.com",
            "x.com",
            "twitter.com",
            "linkedin.com",
            "youtube.com",
            "reddit.com",
            "pinterest.com",
            "quora.com",
            "medium.com",
          ],
        });
        return results;
      } catch (err: any) {
        console.warn(`[Open Web Search] Failed for "${bestQuery}":`, err.message);
        return [];
      }
    };

    // Execute searches (with max 4 concurrency from limiter)
    const searchRuns = await Promise.all([
      ...queryTasks.map((t) => t()),
      openWebTask(),
    ]);

    for (const runResults of searchRuns) {
      allSearchItems.push(...runResults);
    }

    // Merge, dedupe by URL, max 3 URLs per domain
    const seenUrls = new Set<string>();
    const domainCounts: Record<string, number> = {};
    const filteredSearchItems: SearchResultItem[] = [];

    for (const item of allSearchItems) {
      if (!item.url || seenUrls.has(item.url)) continue;
      const domain = getDomain(item.url);
      const count = domainCounts[domain] || 0;
      if (count >= 3) continue;

      seenUrls.add(item.url);
      domainCounts[domain] = count + 1;
      filteredSearchItems.push(item);
    }

    console.log(`[Pipeline Step 2A] Gathered ${allSearchItems.length} raw search results, reduced to ${filteredSearchItems.length} unique items (max 3/domain).`);
    return filteredSearchItems;
  })();

  // B) Source listing pages
  const listingPagesPromise = (async () => {
    const listingUrls: Array<{ url: string; sourceName: string }> = [];

    for (const src of relevantSources) {
      listingUrls.push({ url: src.url, sourceName: src.name });
    }

    // For Internshala, also try keyword URLs for the top 2 keywords
    if (activeCategories.includes("Internships")) {
      const topKeywords = understanding.keywords.slice(0, 2);
      for (const kw of topKeywords) {
        const slug = slugify(kw);
        if (slug) {
          const internshalaKeywordUrl = `https://internshala.com/internships/${slug}-internship/`;
          listingUrls.push({
            url: internshalaKeywordUrl,
            sourceName: `Internshala (${kw})`,
          });
        }
      }
    }

    console.log(`[Pipeline Step 2B] Identified ${listingUrls.length} source listing URLs to check.`);
    return listingUrls;
  })();

  const [searchItems, listingUrls] = await Promise.all([
    searchPromise,
    listingPagesPromise,
  ]);

  // ==========================================
  // STEP 3 - TRIAGE SEARCH RESULTS (Gemini)
  // ==========================================
  onProgress({
    stage: "triaging",
    message: `Triaging ${searchItems.length} search results to find the most promising opportunity pages...`,
    stepIndex: 2,
    data: { searchCount: searchItems.length },
  });

  const triaged: TriagedUrl[] = await geminiTriage(searchItems, understanding.keywords);

  console.log(`[Pipeline Step 3 Done] Triaged to ${triaged.length} high-confidence target URLs.`);

  // ==========================================
  // STEP 4 - FETCH
  // ==========================================
  onProgress({
    stage: "fetching",
    message: "Reading listing pages and triaged opportunity pages with TinyFish Fetch...",
    stepIndex: 3,
    data: { triagedCount: triaged.length },
  });

  // Prepare URL map and source name map
  const sourceNameMap: Record<string, string> = {};
  const urlsToFetchSet = new Set<string>();

  // Add source listing URLs
  for (const item of listingUrls) {
    urlsToFetchSet.add(item.url);
    sourceNameMap[item.url] = item.sourceName;
  }

  // Add triaged URLs
  for (const t of triaged) {
    if (!urlsToFetchSet.has(t.url)) {
      urlsToFetchSet.add(t.url);
      const domain = getDomain(t.url);
      const matchedSource = TRUSTED_SOURCES.find((s) => s.domain === domain);
      sourceNameMap[t.url] = matchedSource ? matchedSource.name : (domain || "Web");
    }
  }

  const allUrlsToFetch = Array.from(urlsToFetchSet);
  console.log(`[Pipeline Step 4] Total unique URLs to fetch: ${allUrlsToFetch.length}`);

  // Fetch with TinyFish
  const fetchedPages: FetchedPageContent[] = await tinyfishFetch(
    allUrlsToFetch,
    sourceNameMap
  );

  // Send progress pills for each page fetched
  for (const page of fetchedPages) {
    onProgress({
      stage: "fetching",
      message: `Read ${page.sourceName || page.url} (${page.chars} chars - ${page.status})`,
      stepIndex: 3,
      data: {
        fetchedPage: {
          url: page.url,
          status: page.status,
          chars: page.chars,
          sourceName: page.sourceName,
        },
      },
    });
  }

  // Count chars and stats
  console.log(`[Pipeline Step 4 Done] Successfully fetched ${fetchedPages.length} pages.`);

  // ==========================================
  // STEP 5 - EXTRACT AND MATCH (Gemini)
  // Max 4 parallel calls
  // ==========================================
  onProgress({
    stage: "matching",
    message: "Extracting verified live opportunities with Gemini...",
    stepIndex: 4,
  });

  // Prioritize triaged opportunity URLs first (highest yield), then rich listing pages
  const triagedUrlSet = new Set(triaged.map((t) => t.url));
  const pagesToExtract = fetchedPages
    .filter((p) => p.chars >= 300)
    .sort((a, b) => {
      const aIsTriaged = triagedUrlSet.has(a.url) ? 1 : 0;
      const bIsTriaged = triagedUrlSet.has(b.url) ? 1 : 0;
      if (bIsTriaged !== aIsTriaged) return bIsTriaged - aIsTriaged;
      return b.chars - a.chars;
    })
    .slice(0, 6); // Top 6 high-relevance pages for fast response

  console.log(`[Pipeline Step 5] Extracting from top ${pagesToExtract.length} high-confidence pages...`);

  let completedPages = 0;
  const extractionResults = await runWithConcurrency(
    pagesToExtract,
    2, // Pace with 2 parallel calls to stay within RPM quotas
    async (page, idx) => {
      const srcName = page.sourceName || sourceNameMap[page.url] || getDomain(page.url) || "Web";
      onProgress({
        stage: "matching",
        message: `Analyzing live opportunities in ${srcName} (${completedPages + 1}/${pagesToExtract.length})...`,
        stepIndex: 4,
      });

      const opps = await geminiExtractAndMatch(
        page.text,
        page.url,
        srcName,
        todayDate,
        understanding.keywords,
        input.profile
      );

      completedPages++;
      onProgress({
        stage: "matching",
        message: `Extracted ${opps.length} opportunities from ${srcName} (${completedPages}/${pagesToExtract.length})`,
        stepIndex: 4,
      });

      return { url: page.url, opportunities: opps };
    }
  );

  const rawOpportunities: Opportunity[] = [];
  const urlOpportunityCount: Record<string, number> = {};

  for (const res of extractionResults) {
    if (res && res.opportunities) {
      rawOpportunities.push(...res.opportunities);
      urlOpportunityCount[res.url] = res.opportunities.length;
    }
  }

  console.log(`[Pipeline Step 5 Done] Extracted ${rawOpportunities.length} raw opportunity candidates.`);

  // ==========================================
  // STEP 6 - VALIDATE AND RANK (in code, not AI)
  // ==========================================
  onProgress({
    stage: "ranking",
    message: "Validating deadlines, removing expired items, and ranking...",
    stepIndex: 5,
  });

  let droppedExpiredCount = 0;
  const validItems: Opportunity[] = [];

  for (const item of rawOpportunities) {
    // 1. Drop items where deadline_iso is before today
    if (item.deadline_iso) {
      // Validate date format YYYY-MM-DD
      const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
      if (dateRegex.test(item.deadline_iso)) {
        if (item.deadline_iso < todayDate) {
          droppedExpiredCount++;
          console.log(`[Pipeline Step 6] Dropped expired item: "${item.title}" | Deadline: ${item.deadline_iso} < Today: ${todayDate}`);
          continue;
        }
      }
    } else {
      // Items with deadline_iso null are kept but labelled
      if (!item.deadline_text || item.deadline_text.toLowerCase().includes("not specified")) {
        item.deadline_text = "Deadline not listed - check link";
      }
    }

    validItems.push(item);
  }

  console.log(`[Pipeline Step 6] Dropped ${droppedExpiredCount} expired items. ${validItems.length} live items remain.`);

  // 2. Dedupe by normalized title + organization (keep the one with more info)
  const dedupeMap = new Map<string, Opportunity>();

  for (const item of validItems) {
    const key = `${normalizeKey(item.title)}_${normalizeKey(item.organization)}`;
    const existing = dedupeMap.get(key);

    if (!existing) {
      dedupeMap.set(key, item);
    } else {
      // Compare richness of information: longer evidence + eligibility + stipend
      const existingInfoScore =
        (existing.evidence?.length || 0) +
        (existing.eligibility?.length || 0) +
        (existing.stipend_or_prize?.length || 0) +
        (existing.deadline_iso ? 50 : 0);

      const currentInfoScore =
        (item.evidence?.length || 0) +
        (item.eligibility?.length || 0) +
        (item.stipend_or_prize?.length || 0) +
        (item.deadline_iso ? 50 : 0);

      if (currentInfoScore > existingInfoScore) {
        dedupeMap.set(key, item);
      }
    }
  }

  const dedupedItems = Array.from(dedupeMap.values());
  console.log(`[Pipeline Step 6] Deduplicated ${validItems.length} items to ${dedupedItems.length} unique opportunities.`);

  // 3. Sort by fit_score desc, then nearest deadline
  dedupedItems.sort((a, b) => {
    // Fit score descending
    if (b.fit_score !== a.fit_score) {
      return b.fit_score - a.fit_score;
    }
    // Nearest deadline ascending (items with null deadline go to end)
    if (a.deadline_iso && b.deadline_iso) {
      return a.deadline_iso.localeCompare(b.deadline_iso);
    }
    if (a.deadline_iso && !b.deadline_iso) return -1;
    if (!a.deadline_iso && b.deadline_iso) return 1;
    return 0;
  });

  // 4. Return max 30
  const finalOpportunities = dedupedItems.slice(0, 30).map((item, index) => ({
    ...item,
    id: `opp-${index + 1}`,
  }));

  // Compile source report for all 20 sources
  const sourceReports: SourceReport[] = TRUSTED_SOURCES.map((src) => {
    const isRelevant = activeCategories.includes(src.category);
    if (!isRelevant) {
      return {
        name: src.name,
        url: src.url,
        domain: src.domain,
        category: src.category,
        status: "unused",
        chars: 0,
        opportunitiesFound: 0,
      };
    }

    // Find fetched pages matching this source
    const matchedFetched = fetchedPages.filter(
      (p) => getDomain(p.url) === src.domain || p.url.includes(src.domain)
    );

    let status: "ok" | "thin" | "failed" | "unused" = "unused";
    let maxChars = 0;
    let foundCount = 0;

    if (matchedFetched.length > 0) {
      maxChars = Math.max(...matchedFetched.map((p) => p.chars));
      if (maxChars >= 500) status = "ok";
      else if (maxChars > 0) status = "thin";
      else status = "failed";
    }

    // Count opportunities found from this source
    for (const opp of finalOpportunities) {
      if (
        opp.source_name?.toLowerCase().includes(src.name.toLowerCase()) ||
        opp.link.includes(src.domain)
      ) {
        foundCount++;
      }
    }

    return {
      name: src.name,
      url: src.url,
      domain: src.domain,
      category: src.category,
      status,
      chars: maxChars,
      opportunitiesFound: foundCount,
    };
  });

  onProgress({
    stage: "done",
    message: `Found ${finalOpportunities.length} live matching opportunities!`,
    stepIndex: 5,
    data: {
      opportunities: finalOpportunities,
      sources: sourceReports,
    },
  });

  console.log(`\n==================================================`);
  console.log(`[Pipeline Complete] Delivering ${finalOpportunities.length} curated opportunities to student.`);
  console.log(`==================================================\n`);

  return {
    opportunities: finalOpportunities,
    sources: sourceReports,
  };
}
