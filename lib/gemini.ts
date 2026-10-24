import { GoogleGenAI } from "@google/genai";
import {
  Opportunity,
  OpportunityCategory,
  SearchResultItem,
  TriagedUrl,
  UnderstandingResult,
} from "./types";
import { getEnv } from "./env";

function getGeminiClient(): { ai: GoogleGenAI; model: string } {
  const apiKey = getEnv("GEMINI_API_KEY");
  if (!apiKey || apiKey.includes("your_gemini_api_key")) {
    throw new Error("Missing or invalid GEMINI_API_KEY. Please set it in .env.local");
  }
  const model = getEnv("GEMINI_MODEL", "gemini-3.5-flash");
  const ai = new GoogleGenAI({ apiKey: apiKey.trim() });
  return { ai, model };
}

/**
 * Clean and parse JSON returned from LLMs (handles markdown code fences and object wrappers)
 */
function parseJsonFromText(rawText: string | undefined): any {
  if (!rawText) return null;
  let cleaned = rawText.trim();

  // Strip markdown code fences if present
  const jsonBlockMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (jsonBlockMatch) {
    cleaned = jsonBlockMatch[1].trim();
  } else if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```[a-z]*\s*/i, "").replace(/\s*```$/, "").trim();
  }

  try {
    return JSON.parse(cleaned);
  } catch {
    // Try to extract first JSON array
    const firstBracket = cleaned.indexOf("[");
    const lastBracket = cleaned.lastIndexOf("]");
    if (firstBracket !== -1 && lastBracket > firstBracket) {
      try {
        return JSON.parse(cleaned.slice(firstBracket, lastBracket + 1));
      } catch {}
    }

    // Try to extract first JSON object
    const firstBrace = cleaned.indexOf("{");
    const lastBrace = cleaned.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try {
        return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
      } catch {}
    }

    return null;
  }
}

/**
 * Helper withTimeout to prevent hanging API calls
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timer!);
  }
}

// Global cache of models that have hit daily quota exhaustion, so subsequent calls skip them instantly
const exhaustedModels = new Set<string>();

/**
 * Helper to call NVIDIA Nemotron (via NVIDIA NIM endpoint)
 */
async function callNemotronJson(prompt: string): Promise<any> {
  const apiKey = getEnv("NEMOTRON_API_KEY");
  if (!apiKey || apiKey.includes("your_nemotron_api_key")) {
    throw new Error("NEMOTRON_API_KEY is not configured in .env.local");
  }

  const baseUrl = (getEnv("NEMOTRON_BASE_URL", "https://integrate.api.nvidia.com/v1")).replace(/\/+$/, "");
  const model = getEnv("NEMOTRON_MODEL", "nvidia/nemotron-3.5-super-vl-120b-a12b");

  console.log(`[Nemotron] Calling model "${model}" via ${baseUrl}...`);

  const response = await withTimeout(
    fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content:
              "You are an expert AI assistant. You MUST return strictly valid JSON matching the user instructions without any conversational commentary or markdown codeblocks outside JSON.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
        temperature: 0.2,
        max_tokens: 4096,
      }),
    }),
    20000,
    "Nemotron API request timed out after 20s"
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Nemotron API error ${response.status}: ${errorText}`);
  }

  const data = await response.json();
  const rawText = data?.choices?.[0]?.message?.content;
  return parseJsonFromText(rawText);
}

/**
 * Helper to call Gemini generateContent with retries and seamless fallback to Nemotron
 */
async function callGeminiJson(prompt: string): Promise<any> {
  let geminiError: any = null;
  const geminiApiKey = getEnv("GEMINI_API_KEY");
  const nemotronApiKey = getEnv("NEMOTRON_API_KEY");

  // Check if we can use Gemini models
  if (geminiApiKey && !geminiApiKey.includes("your_gemini_api_key")) {
    try {
      const { ai, model: primaryModel } = getGeminiClient();
      const candidateModels = Array.from(
        new Set([primaryModel, "gemini-3.5-flash", "gemini-3.1-flash-lite", "gemini-3.8-flash"])
      );

      // Only attempt models that haven't already failed with quota exhaustion
      const modelsToTry = candidateModels.filter((m) => !exhaustedModels.has(m));

      for (const model of modelsToTry) {
        try {
          console.log(`[Gemini] Calling ${model}...`);
          const response = await withTimeout(
            ai.models.generateContent({
              model: model,
              contents: prompt,
              config: {
                responseMimeType: "application/json",
              },
            }),
            12000,
            `Model ${model} timed out after 12s`
          );

          const parsed = parseJsonFromText(response.text);
          if (parsed !== null) {
            return parsed;
          }
        } catch (err: any) {
          geminiError = err;
          const errMsg = err?.message || "";
          console.warn(`[Gemini] Model ${model} failed: ${errMsg}`);

          // If daily quota exceeded or model discontinued, mark model permanently exhausted for this session
          if (
            errMsg.includes("per day") ||
            errMsg.includes("exceeded your current quota") ||
            errMsg.includes("RESOURCE_EXHAUSTED") ||
            errMsg.includes("GenerateRequestsPerDayPerProjectPerModel-FreeTier") ||
            errMsg.includes("not found") ||
            errMsg.includes("no longer available")
          ) {
            console.log(`[Gemini] Model ${model} daily quota exhausted. Blacklisting for session...`);
            exhaustedModels.add(model);
          }
        }
      }
    } catch (e: any) {
      geminiError = e;
    }
  }

  // Seamless fallback to Nemotron if Gemini failed or all Gemini models are exhausted
  if (nemotronApiKey && !nemotronApiKey.includes("your_nemotron_api_key")) {
    console.log("[LLM Fallback] Route request to NVIDIA Nemotron NIM...");
    try {
      return await callNemotronJson(prompt);
    } catch (nemotronErr: any) {
      console.error("[Nemotron] Fallback call failed:", nemotronErr.message);
      if (geminiError) throw geminiError;
      throw nemotronErr;
    }
  }

  if (geminiError) throw geminiError;
  throw new Error("No available AI model. Please set GEMINI_API_KEY or NEMOTRON_API_KEY in .env.local");
}

/**
 * STEP 1: UNDERSTAND
 * Analyze lookingFor + profile + today's date
 */
export async function geminiUnderstand(
  lookingFor: string,
  profile: string,
  todayDate: string,
  userSelectedCategories?: string[]
): Promise<UnderstandingResult> {
  console.log(`[Gemini Understand] Analyzing student profile & intent for date ${todayDate}...`);

  const categoryContext =
    userSelectedCategories &&
    userSelectedCategories.length > 0 &&
    !userSelectedCategories.includes("All")
      ? `User selected categories: ${userSelectedCategories.join(", ")}`
      : `User selected: All (Decide best categories from: Internships, Hackathons, Competitions, Scholarships, Fellowships, Open Source)`;

  const prompt = `You are an AI assistant helping Indian college students find live opportunities (internships, hackathons, competitions, scholarships, fellowships, open-source programs).
Analyze the student's request and profile.

Today's date is: ${todayDate}
Student is looking for: "${lookingFor}"
Student profile: "${profile}"
${categoryContext}

Extract and return a JSON object with this exact structure:
{
  "categories": ["Internships", "Hackathons", ...from the 6 categories: "Internships", "Hackathons", "Competitions", "Scholarships", "Fellowships", "Open Source"],
  "keywords": ["5-8 specific keywords, e.g. machine learning, NLP, Python, stipend, remote"],
  "skills": ["list of user skills"],
  "level": "1st year | 2nd year | 3rd year | final year | graduate",
  "location_preference": "remote | <city name> | any",
  "search_queries": [
    "5 short, specific search queries combining keywords with opportunity words like 'internship apply', 'hackathon registration open', 'scholarship 2026-27 last date', 'fellowship 2027 apply'"
  ]
}`;

  const result = await callGeminiJson(prompt);

  const categories: OpportunityCategory[] = Array.isArray(result?.categories) && result.categories.length > 0
    ? result.categories
    : ["Internships", "Hackathons"];

  const keywords: string[] = Array.isArray(result?.keywords) && result.keywords.length > 0
    ? result.keywords
    : ["internship", "hackathon", "student"];

  const search_queries: string[] = Array.isArray(result?.search_queries) && result.search_queries.length > 0
    ? result.search_queries
    : [`${keywords[0] || "internship"} apply 2026`, `${keywords[1] || "hackathon"} registration open`];

  console.log(`[Gemini Understand] Extracted categories:`, categories);
  console.log(`[Gemini Understand] Extracted keywords:`, keywords);
  console.log(`[Gemini Understand] Search queries:`, search_queries);

  return {
    categories,
    keywords,
    skills: Array.isArray(result?.skills) ? result.skills : [],
    level: result?.level || "Undergraduate student",
    location_preference: result?.location_preference || "any",
    search_queries,
  };
}

/**
 * STEP 3: TRIAGE SEARCH RESULTS
 * Filter out blogs, forum posts, expired cycles, aggregate listicles without specifics.
 * Keep ONLY direct links to actual opportunities or rich listing pages. Max 8 URLs.
 */
export async function geminiTriage(
  searchResults: SearchResultItem[],
  keywords: string[]
): Promise<TriagedUrl[]> {
  if (!searchResults || searchResults.length === 0) return [];

  console.log(`[Gemini Triage] Triaging ${searchResults.length} search results against keywords...`);

  const prompt = `You are an AI assistant filtering search results to find current, live opportunity pages for Indian college students.
Student keywords: ${keywords.join(", ")}

Here are ${searchResults.length} search result candidates:
${JSON.stringify(
  searchResults.map((r, i) => ({
    index: i,
    title: r.title,
    snippet: r.snippet,
    url: r.url,
  })),
  null,
  2
)}

Instruction:
Filter out:
- Generic blog posts or listicles ("Top 10 internships in 2024")
- Past or expired programs (dates prior to late 2026)
- Career advice articles, YouTube videos, LinkedIn login walls
- Empty or irrelevant pages

Keep ONLY:
- Direct links to specific open opportunities with applications/deadlines
- Live portal listing pages that contain multiple open opportunities matching the student's keywords

Return a JSON array of up to 8 items in this format:
[
  {
    "url": "https://...",
    "reason": "why this page is promising"
  }
]`;

  try {
    const result = await callGeminiJson(prompt);
    let triagedArray: any[] = [];
    if (Array.isArray(result)) {
      triagedArray = result;
    } else if (result && typeof result === "object") {
      if (Array.isArray(result.triaged)) triagedArray = result.triaged;
      else if (Array.isArray(result.urls)) triagedArray = result.urls;
      else if (Array.isArray(result.results)) triagedArray = result.results;
    }

    const triaged: TriagedUrl[] = triagedArray.map((t: any) => ({
      url: t.url || "",
      reason: t.reason || "Matched student keywords",
    })).filter((t) => t.url.startsWith("http"));

    console.log(`[Gemini Triage] Picked ${triaged.length} promising URLs:`);
    for (const t of triaged) {
      console.log(`  - [${t.url}] -> Reason: ${t.reason}`);
    }
    return triaged.slice(0, 8);
  } catch (err: any) {
    console.error("[Gemini Triage] Triage call failed, falling back to top 8 search results:", err.message);
    return searchResults.slice(0, 8).map((r) => ({
      url: r.url,
      reason: "Fallback search ranking",
    }));
  }
}

/**
 * STEP 5: EXTRACT AND MATCH
 * Send page text (first 20,000 chars), page URL, source name, today's date, keywords, and profile.
 * Extract ONLY real, specific opportunities that are currently open or upcoming.
 */
export async function geminiExtractAndMatch(
  pageText: string,
  pageUrl: string,
  sourceName: string,
  todayDate: string,
  keywords: string[],
  profile: string
): Promise<Opportunity[]> {
  const truncatedText = pageText.slice(0, 20000);
  console.log(`[Gemini Extract] Extracting opportunities from ${sourceName} (${pageUrl}, ${truncatedText.length} chars)...`);

  const prompt = `Extract ONLY real, specific opportunities that are currently open or upcoming as of today.
Today's Date: ${todayDate}
Source Name: ${sourceName}
Page URL: ${pageUrl}
Student Profile: ${profile}
Student Keywords: ${keywords.join(", ")}

Page Text (first 20,000 characters):
"""
${truncatedText}
"""

Instruction:
Extract ONLY real, specific opportunities that are currently open or upcoming as of today. Ignore ads, navigation, promotional fluff, and expired items.
If the page only shows past dates or the program is between cycles, return an empty array [].
NEVER invent or guess deadlines. If a deadline is not explicitly mentioned, set deadline_iso to null and deadline_text to "Not specified".

Return a JSON array, max 10 items:
[
  {
    "title": "Title of the opportunity",
    "organization": "Company or host organization",
    "type": "Internship | Hackathon | Competition | Scholarship | Fellowship | Open Source",
    "mode": "Online | In-person | Hybrid | Remote | Unknown",
    "location": "Location (e.g. Bengaluru, Remote, India, Global)",
    "deadline_text": "Deadline as stated on page or 'Not specified'",
    "deadline_iso": "YYYY-MM-DD or null",
    "eligibility": "One line summarizing eligibility",
    "stipend_or_prize": "Stipend amount, prize pool, or null",
    "link": "The specific opportunity URL if present in the page, otherwise the page URL",
    "evidence": "Short quote from the page showing the deadline or open status",
    "keyword_matches": ["list of user keywords this matches"],
    "fit_score": 8, // Integer 1-10 based on keywords, skills, level, location
    "why_it_fits": "One sentence written directly to the student explaining why this is a good fit"
  }
]`;

  try {
    const result = await callGeminiJson(prompt);
    let itemsArray: any[] = [];
    if (Array.isArray(result)) {
      itemsArray = result;
    } else if (result && typeof result === "object") {
      if (Array.isArray(result.opportunities)) itemsArray = result.opportunities;
      else if (Array.isArray(result.items)) itemsArray = result.items;
      else if (Array.isArray(result.results)) itemsArray = result.results;
      else if (Array.isArray(result.data)) itemsArray = result.data;
    }

    const items: Opportunity[] = itemsArray.map((item: any) => ({
      title: item.title || "Untitled Opportunity",
      organization: item.organization || sourceName,
      type: item.type || "Internship",
      mode: item.mode || "Unknown",
      location: item.location || "India",
      deadline_text: item.deadline_text || "Not specified",
      deadline_iso: item.deadline_iso || null,
      eligibility: item.eligibility || "Open to eligible students",
      stipend_or_prize: item.stipend_or_prize || null,
      link: item.link && item.link.startsWith("http") ? item.link : pageUrl,
      evidence: item.evidence || "",
      keyword_matches: Array.isArray(item.keyword_matches) ? item.keyword_matches : [],
      fit_score: typeof item.fit_score === "number" ? Math.min(10, Math.max(1, Math.round(item.fit_score))) : 7,
      why_it_fits: item.why_it_fits || "Matches your profile and interests.",
      source_name: sourceName,
    }));

    console.log(`[Gemini Extract] Found ${items.length} opportunities from ${pageUrl}`);
    return items;
  } catch (err: any) {
    console.error(`[Gemini Extract] Extraction error for ${pageUrl}:`, err.message);
    return [];
  }
}
