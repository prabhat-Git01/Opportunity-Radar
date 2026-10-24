# Opportunity Radar 📡

> Live opportunities from 20 trusted sources, matched directly to Indian college students.

**Opportunity Radar** helps Indian undergraduate and graduate students discover currently open, verified internships, hackathons, competitions, scholarships, fellowships, and open-source programs matching their background and skills.

Instead of stale scrapers or static databases, Opportunity Radar combines:
1. **TinyFish Search & Fetch APIs** for live, real-time web retrieval across 20 curated portals.
2. **Google Gemini 2.5 Flash** (`@google/genai`) with structured JSON mode for student profile understanding, opportunity triage, and verified deadline extraction.
3. **Server-Sent Events (SSE)** to stream search progress, extracted keywords, and reading progress directly to the browser.
4. **Client-side filtering & sorting** by opportunity type, closing soon deadlines, and fit score.

---

## Quick Setup (4 Steps)

### Step 1: Install Dependencies
```bash
npm install
```

### Step 2: Configure API Keys in `.env.local`
Create or edit `.env.local` in the project root:
```env
# TinyFish API Key (from https://agent.tinyfish.ai/api-keys)
TINYFISH_API_KEY=your_tinyfish_api_key_here

# Google Gemini API Key (from https://aistudio.google.com/apikey)
GEMINI_API_KEY=your_gemini_api_key_here

# Fast Gemini Flash model (default: gemini-2.5-flash)
GEMINI_MODEL=gemini-2.5-flash
```

*(Refer to `.env.example` for reference. API keys are strictly kept server-side and never exposed to the client browser).*

### Step 3: Verify Trusted Sources
Run the automated test script to fetch and inspect all 20 trusted source portals via TinyFish Fetch:
```bash
npm run test:sources
```
This prints an overview table with each source name, HTTP extraction status (`OK`, `THIN`, or `FAILED`), returned character counts, and the first 120 characters of clean text.

### Step 4: Launch Development Server
```bash
npm run dev
```
Open [http://localhost:3000](http://localhost:3000) in your browser.

---

## How It Works (The 6-Step Radar Pipeline)

When a student enters their request (e.g. *"Paid AI/ML internship, remote or hybrid"*), the backend executes a 6-step pipeline streamed in real time via SSE (`POST /api/radar`):

1. **Step 1 — Understand (Gemini)**: Extracts categories, 5–8 targeted keywords, education level, location preferences, and 5 short search queries. Extracted keywords appear instantly in the UI.
2. **Step 2 — Gather (Parallel)**:
   - **2A: Targeted Search**: Runs queries on TinyFish Search with `location="IN"`, `language="en"`, `after_date` = 60 days ago, filtered to trusted source domains, plus an open-web query excluding noisy social media.
   - **2B: Listing Pages**: Gathers canonical listing URLs from selected categories (and keyword-specific URLs for portals like Internshala).
3. **Step 3 — Triage (Gemini)**: Evaluates all gathered URLs against the student keywords and picks the top 8 most promising opportunity pages, filtering out listicles, outdated recaps, and winner announcements.
4. **Step 4 — Fetch (TinyFish Fetch)**: Fetches pages in batches of 10. Automatically caches pages in memory for 30 minutes to conserve tokens and API calls. Reports status (`ok` &ge; 500 chars, `thin` < 500 chars, `failed`).
5. **Step 5 — Extract & Match (Gemini)**: Executes parallel extraction (up to 4 concurrent calls) over page text (first 20,000 characters) to extract structured opportunities with eligibility, mode, stipend/prize, verified evidence, fit scores, and a personal *why it fits* note.
6. **Step 6 — Validate & Rank (Code)**: Drops expired deadlines, labels missing deadlines as *"Deadline not listed - check link"*, deduplicates across identical titles/organizations, and ranks results by `fit_score` descending and nearest deadline.

---

## Trusted Sources Network

All trusted sources are centralized in [`/config/sources.ts`](./config/sources.ts):

| Category | Source | URL / Domain |
|---|---|---|
| **Internships** | Internshala | `https://internshala.com/internships/` |
| **Internships** | AICTE Internship Portal | `https://internship.aicte-india.org/internships` |
| **Internships** | PM Internship Scheme | `https://pminternship.mca.gov.in` |
| **Hackathons** | Devfolio | `https://devfolio.co/hackathons` |
| **Hackathons** | Hack2skill | `https://hack2skill.com/hackathons-listing` |
| **Hackathons** | HackCulture | `https://www.hackculture.io` |
| **Hackathons** | MLH | `https://www.mlh.com/events` |
| **Hackathons** | lablab.ai | `https://lablab.ai/ai-hackathons` |
| **Hackathons** | DoraHacks | `https://dorahacks.io/hackathon` |
| **Competitions** | Unstop | `https://unstop.com/competitions` |
| **Competitions** | Kaggle | `https://www.kaggle.com/competitions` |
| **Competitions** | MyGov Innovate India | `https://innovateindia.mygov.in/` |
| **Scholarships** | Buddy4Study | `https://www.buddy4study.com/online-application-form` |
| **Scholarships** | National Scholarship Portal | `https://scholarships.gov.in/Students` |
| **Scholarships** | DAAD India | `https://www.daad.in/en/find-funding/scholarship-database/` |
| **Fellowships** | IASc Summer Research Fellowship | `https://webjapps.ias.ac.in/fellowship2027/index.html` |
| **Fellowships** | Teach For India | `https://teachforindia.org/how-to-be-a-fellow` |
| **Open Source** | Google Summer of Code | `https://developers.google.com/open-source/gsoc/timeline` |
| **Open Source** | GirlScript Summer of Code | `https://gssoc.girlscript.org` |
| **Open Source** | Outreachy | `https://www.outreachy.org/apply/project-selection/` |

### Adding or Removing Sources
To add or remove sources, simply edit `config/sources.ts`:
```typescript
{
  name: "New Platform",
  url: "https://example.com/opportunities",
  domain: "example.com",
  category: "Internships",
  jsHeavy: false
}
```

> [!NOTE]
> **JavaScript-Heavy Sources**: Portals marked `jsHeavy: true` (e.g. Unstop, Buddy4Study, DoraHacks) render interactive single-page apps (SPAs) on the client. Standard HTTP Fetch may return thin text (`< 500 chars`). These sources are prime candidates for the **TinyFish Agent API** (`client.agent.run`) in a future update to navigate dynamic browser DOMs directly.

---

## Console Logging & Debugging

Every pipeline run produces structured, detailed server console logs:
- `[Gemini Understand]` Extracted keywords, level, and generated search queries.
- `[TinyFish Search]` Exact queries, domains included/excluded, and raw response of the first call.
- `[Pipeline Step 2A]` Total raw items gathered and deduplicated count per domain.
- `[Gemini Triage]` URLs selected with explicit reasoning for inclusion.
- `[TinyFish Fetch]` Batch fetch progress, char counts, and cache hit/miss status.
- `[Gemini Extract]` Opportunity extraction counts per page.
- `[Pipeline Step 6]` Drop log for expired deadlines (`item < todayDate`) and deduplication stats.

---

## License
MIT
