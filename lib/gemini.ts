import { GoogleGenAI } from "@google/genai";
import {
  Opportunity,
  OpportunityCategory,
  SearchResultItem,
  TriagedUrl,
  UnderstandingResult,
} from "./types";

function getGeminiClient(): { ai: GoogleGenAI; model: string } {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey.trim() === "" || apiKey.includes("your_gemini_api_key")) {
    throw new Error("Missing or invalid GEMINI_API_KEY. Please set it in .env.local");
  }
  const model = process.env.GEMINI_MODEL?.trim() || "gemini-3.5-flash";
  const ai = new GoogleGenAI({ apiKey: apiKey.trim() });
  return { ai, model };
}

/**
 * Clean and parse JSON returned from LLMs (handles markdown code fences if any)
 */
function parseJsonFromText(rawText: string | undefined): any {
  if (!rawText) return null;
  let cleaned = rawText.trim();
  if (cleaned.startsWith("```json")) {
    cleaned = cleaned.replace(/^```json\s*/, "").replace(/\s*```$/, "");
  } else if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```\s*/, "").replace(/\s*```$/, "");
  }
  return JSON.parse(cleaned.trim());
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

/**
 * Helper to call NVIDIA Nemotron (via NVIDIA NIM or OpenRouter / OpenAI-compatible endpoint)
 */
async function callNemotronJson(prompt: string): Promise<any> {
  const apiKey = process.env.NEMOTRON_API_KEY?.trim();
  if (!apiKey || apiKey.includes("your_nemotron_api_key")) {
    throw new Error("NEMOTRON_API_KEY is not configured in .env.local");
  }

  const baseUrl = (process.env.NEMOTRON_BASE_URL?.trim() || "https://integrate.api.nvidia.com/v1").replace(/\/+$/, "");
  const model = process.env.NEMOTRON_MODEL?.trim() || "nvidia/llama-3.1-nemotron-70b-instruct";

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
    35000,
    "Nemotron API request timed out after 35s"
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
 * Helper to call Gemini generateContent with retries and fallback to Nemotron
 */
async function callGeminiJson(prompt: string): Promise<any> {
  let geminiError: any = null;
  const geminiApiKey = process.env.GEMINI_API_KEY?.trim();

  // Try Gemini models if GEMINI_API_KEY is provided
  if (geminiApiKey && !geminiApiKey.includes("your_gemini_api_key")) {
    try {
      const { ai, model: primaryModel } = getGeminiClient();
      const modelsToTry = Array.from(
        new Set([primaryModel, "gemini-3.5-flash", "gemini-3.1-flash-lite", "gemini-3.8-flash"])
      );

      for (const model of modelsToTry) {
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            console.log(`[Gemini] Calling ${model} (attempt ${attempt + 1})...`);
            const response = await withTimeout(
              ai.models.generateContent({
                model: model,
                contents: prompt,
                config: {
                  responseMimeType: "application/json",
                },
              }),
              25000,
              `Model ${model} timed out after 25s`
            );

            return parseJsonFromText(response.text);
          } catch (err: any) {
            geminiError = err;
            const errMsg = err?.message || "";
            console.warn(`[Gemini] Model ${model} attempt ${attempt + 1} failed: ${errMsg}`);

            // If daily quota exceeded or model discontinued, do NOT retry this model; switch immediately
            if (
              errMsg.includes("per day") ||
              errMsg.includes("exceeded your current quota") ||
              errMsg.includes("not found") ||
              errMsg.includes("no longer available")
            ) {
              console.log(`[Gemini] Model ${model} quota exhausted. Switching model...`);
              break;
            }

            // If temporary RPM rate limit, wait 3s and retry once
            if (errMsg.includes("requests per minute") || errMsg.includes("429")) {
              console.log(`[Gemini] RPM limit on ${model}. Waiting 3s...`);
              await new Promise((r) => setTimeout(r, 3000));
              continue;
            }

            // If 503 high demand
            if (errMsg.includes("503") || errMsg.includes("high demand")) {
              await new Promise((r) => setTimeout(r, 2000));
              continue;
            }

            break;
          }
        }
      }
    } catch (e: any) {
      geminiError = e;
    }
  }

  // Seamless fallback to Nemotron if Gemini failed or is unavailable
  const nemotronKey = process.env.NEMOTRON_API_KEY?.trim();
  if (nemotronKey && !nemotronKey.includes("your_nemotron_api_key")) {
    console.log("[LLM Fallback] Gemini models unavailable, falling back to NVIDIA Nemotron...");
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
 * Pick the 8 most promising URLs that look like a SPECIFIC opportunity page or a live listing page.
 * Reject listicles ("top 10", "best", "how to", "tips"), news recaps, winners/results pages and anything clearly past its date.
 */
export async function geminiTriage(
  searchResults: SearchResultItem[],
  keywords: string[]
): Promise<TriagedUrl[]> {
  console.log(`[Gemini Triage] Triaging ${searchResults.length} search results against keywords...`);

  if (searchResults.length === 0) return [];

  const prompt = `You are an expert opportunity scout for Indian students.
Given the student's keywords: ${keywords.join(", ")}
And these search results:
${JSON.stringify(
  searchResults.map((r) => ({
    title: r.title,
    snippet: r.snippet,
    url: r.url,
    date: r.date,
  })),
  null,
  2
)}

Pick the 8 most promising URLs that look like a SPECIFIC opportunity page or a live listing page.
Reject listicles ("top 10", "best", "how to", "tips"), news recaps, blog articles, winners/results pages, and anything clearly past its date or expired.

Return a JSON array of up to 8 items:
[
  {
    "url": "https://...",
    "reason": "specific reason why this URL is promising"
  }
]`;

  try {
    const result = await callGeminiJson(prompt);
    const triaged: TriagedUrl[] = Array.isArray(result) ? result : [];
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
    if (!Array.isArray(result)) return [];

    const items: Opportunity[] = result.map((item: any) => ({
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
