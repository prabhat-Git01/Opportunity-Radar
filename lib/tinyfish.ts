import { FetchedPageContent, SearchResultItem } from "./types";
import { getEnv } from "./env";

const SEARCH_API_URL = "https://api.search.tinyfish.ai";
const FETCH_API_URL = "https://api.fetch.tinyfish.ai";

// 30-minute in-memory cache for fetched pages
interface CacheEntry {
  content: FetchedPageContent;
  expiresAt: number;
}
const pageCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

// Concurrency limiter (max 4 parallel calls)
class ConcurrencyLimiter {
  private maxConcurrent: number;
  private currentRunning = 0;
  private queue: Array<() => void> = [];

  constructor(maxConcurrent = 4) {
    this.maxConcurrent = maxConcurrent;
  }

  async acquire(): Promise<void> {
    if (this.currentRunning < this.maxConcurrent) {
      this.currentRunning++;
      return;
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.currentRunning++;
        resolve();
      });
    });
  }

  release(): void {
    this.currentRunning--;
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

const limiter = new ConcurrencyLimiter(4);
let hasLoggedFirstSearch = false;

function getApiKey(): string {
  const key = getEnv("TINYFISH_API_KEY");
  if (!key || key.includes("your_tinyfish_api_key")) {
    throw new Error("Your API key looks wrong");
  }
  return key;
}

/**
 * Handle HTTP errors with friendly error messages
 */
function handleStatusError(status: number, statusText: string): Error {
  if (status === 401) {
    return new Error("Your API key looks wrong");
  }
  if (status === 402) {
    return new Error("Daily free limit reached");
  }
  if (status === 429) {
    return new Error("Too many requests, wait a minute");
  }
  return new Error(`TinyFish error ${status}: ${statusText}`);
}

/**
 * Fetch wrapper with 429 retry after 3 seconds, timeout, and concurrency limit
 */
async function callWithRetry(
  url: string,
  options: RequestInit,
  timeoutMs: number,
  isRetry = false
): Promise<Response> {
  await limiter.acquire();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (res.status === 429 && !isRetry) {
        console.warn(`[TinyFish] 429 Rate limited on ${url}, retrying in 3 seconds...`);
        await new Promise((r) => setTimeout(r, 3000));
        return await callWithRetry(url, options, timeoutMs, true);
      }

      if (!res.ok) {
        throw handleStatusError(res.status, res.statusText);
      }

      return res;
    } catch (err: any) {
      clearTimeout(timer);
      if (err.name === "AbortError") {
        throw new Error(`Request timed out after ${timeoutMs / 1000}s`);
      }
      if (
        err.message?.includes("fetch failed") ||
        err.code === "ECONNREFUSED" ||
        err.code === "ENOTFOUND"
      ) {
        throw new Error("Couldn't reach TinyFish");
      }
      throw err;
    }
  } finally {
    limiter.release();
  }
}

export interface SearchOptions {
  query: string;
  afterDate?: string; // YYYY-MM-DD
  includeDomains?: string[];
  excludeDomains?: string[];
  location?: string;
  language?: string;
}

/**
 * TinyFish Search API
 * GET https://api.search.tinyfish.ai
 */
export async function tinyfishSearch(options: SearchOptions): Promise<SearchResultItem[]> {
  const apiKey = getApiKey();
  const url = new URL(SEARCH_API_URL);

  url.searchParams.set("query", options.query);
  url.searchParams.set("location", options.location || "IN");
  url.searchParams.set("language", options.language || "en");

  if (options.afterDate) {
    url.searchParams.set("after_date", options.afterDate);
  }

  if (options.includeDomains && options.includeDomains.length > 0) {
    url.searchParams.set("include_domains", options.includeDomains.join(","));
  }

  if (options.excludeDomains && options.excludeDomains.length > 0) {
    url.searchParams.set("exclude_domains", options.excludeDomains.join(","));
  }

  console.log(`[TinyFish Search] Query: "${options.query}" | include_domains: ${options.includeDomains?.join(",") || "none"} | after_date: ${options.afterDate || "none"}`);

  const res = await callWithRetry(
    url.toString(),
    {
      method: "GET",
      headers: {
        "X-API-Key": apiKey,
        Accept: "application/json",
      },
    },
    15000 // 15s timeout
  );

  const rawJson = await res.json();

  if (!hasLoggedFirstSearch) {
    hasLoggedFirstSearch = true;
    console.log("[TinyFish Search] Raw response of first call:", JSON.stringify(rawJson, null, 2));
  }

  if (!rawJson || !Array.isArray(rawJson.results)) {
    console.warn("[TinyFish Search] Unexpected response format, results is not an array:", rawJson);
    return [];
  }

  return rawJson.results.map((r: any, idx: number) => ({
    position: r.position ?? idx + 1,
    title: r.title || "Untitled",
    snippet: r.snippet || "",
    url: r.url,
    site_name: r.site_name,
    date: r.date,
  }));
}

/**
 * TinyFish Fetch API
 * POST https://api.fetch.tinyfish.ai
 * Batches of max 10 URLs
 * Cache 30m
 */
export async function tinyfishFetch(
  urls: string[],
  sourceNames?: Record<string, string>
): Promise<FetchedPageContent[]> {
  if (urls.length === 0) return [];

  const apiKey = getApiKey();
  const now = Date.now();
  const results: FetchedPageContent[] = [];
  const uncachedUrls: string[] = [];

  // Check cache first
  for (const url of urls) {
    const cached = pageCache.get(url);
    if (cached && cached.expiresAt > now) {
      console.log(`[TinyFish Fetch Cache] HIT: ${url} (${cached.content.chars} chars)`);
      results.push(cached.content);
    } else {
      uncachedUrls.push(url);
    }
  }

  if (uncachedUrls.length === 0) {
    return results;
  }

  // Chunk into batches of max 10
  const batches: string[][] = [];
  for (let i = 0; i < uncachedUrls.length; i += 10) {
    batches.push(uncachedUrls.slice(i, i + 10));
  }

  for (const batch of batches) {
    console.log(`[TinyFish Fetch] Fetching batch of ${batch.length} URLs...`);
    try {
      const res = await callWithRetry(
        FETCH_API_URL,
        {
          method: "POST",
          headers: {
            "X-API-Key": apiKey,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({ urls: batch }),
        },
        150000 // 150s timeout
      );

      const data = await res.json();

      // Handle successful items
      // TinyFish fetch may return array of items or { results: [...], errors: [...] }
      const items: any[] = Array.isArray(data)
        ? data
        : Array.isArray(data?.results)
        ? data.results
        : Array.isArray(data?.contents)
        ? data.contents
        : [];

      const fetchedMap = new Map<string, any>();
      for (const item of items) {
        if (item && item.url) {
          fetchedMap.set(item.url, item);
        }
      }

      // Handle reported errors
      const reportedErrors = Array.isArray(data?.errors) ? data.errors : [];
      for (const err of reportedErrors) {
        console.warn(`[TinyFish Fetch] Error reported for URL ${err?.url || "unknown"}: ${err?.error || err?.message || "failed"}`);
      }

      for (const url of batch) {
        const item = fetchedMap.get(url);
        if (item) {
          const text = item.text || item.content || item.markdown || "";
          const chars = text.length;
          const status = chars >= 500 ? "ok" : "thin";
          const pageData: FetchedPageContent = {
            url,
            title: item.title,
            text,
            chars,
            status,
            sourceName: sourceNames?.[url],
          };

          pageCache.set(url, { content: pageData, expiresAt: now + CACHE_TTL_MS });
          results.push(pageData);
          console.log(`[TinyFish Fetch] Success: ${url} -> status: ${status} (${chars} chars)`);
        } else {
          // Failed or errored URL
          const failedData: FetchedPageContent = {
            url,
            text: "",
            chars: 0,
            status: "failed",
            sourceName: sourceNames?.[url],
          };
          pageCache.set(url, { content: failedData, expiresAt: now + 5 * 60 * 1000 }); // short cache for failed
          results.push(failedData);
          console.warn(`[TinyFish Fetch] URL failed or returned no content: ${url}`);
        }
      }
    } catch (err: any) {
      console.error(`[TinyFish Fetch] Batch failed:`, err.message);
      // Never crash: mark all URLs in this batch as failed
      for (const url of batch) {
        const failedData: FetchedPageContent = {
          url,
          text: "",
          chars: 0,
          status: "failed",
          sourceName: sourceNames?.[url],
        };
        results.push(failedData);
      }
    }
  }

  return results;
}
