import { OpportunityCategory, TrustedSource } from "@/config/sources";
export type { OpportunityCategory, TrustedSource };

export type OpportunityType =
  | "Internship"
  | "Hackathon"
  | "Competition"
  | "Scholarship"
  | "Fellowship"
  | "Open Source";

export type OpportunityMode =
  | "Online"
  | "In-person"
  | "Hybrid"
  | "Remote"
  | "Unknown";

export interface Opportunity {
  id?: string;
  title: string;
  organization: string;
  type: OpportunityType;
  mode: OpportunityMode;
  location: string;
  deadline_text: string;
  deadline_iso: string | null; // YYYY-MM-DD or null
  eligibility: string;
  stipend_or_prize: string | null;
  link: string;
  evidence: string;
  keyword_matches: string[];
  fit_score: number; // 1-10
  why_it_fits: string;
  source_name?: string;
}

export interface UserProfileInput {
  lookingFor: string;
  profile: string;
  selectedCategories?: string[]; // "All" or specific categories
}

export interface UnderstandingResult {
  categories: OpportunityCategory[];
  keywords: string[];
  skills: string[];
  level: string;
  location_preference: string;
  search_queries: string[];
}

export interface SearchResultItem {
  position: number;
  title: string;
  snippet: string;
  url: string;
  site_name?: string;
  date?: string;
}

export interface TriagedUrl {
  url: string;
  reason: string;
  sourceName?: string;
}

export interface FetchedPageContent {
  url: string;
  title?: string;
  text: string;
  chars: number;
  status: "ok" | "thin" | "failed";
  sourceName?: string;
}

export interface SourceReport {
  name: string;
  url: string;
  domain: string;
  category: OpportunityCategory;
  status: "ok" | "thin" | "failed" | "unused";
  chars: number;
  opportunitiesFound: number;
}

export type PipelineStage =
  | "understanding"
  | "keywords"
  | "searching"
  | "triaging"
  | "fetching"
  | "matching"
  | "ranking"
  | "done"
  | "error";

export interface PipelineProgressEvent {
  stage: PipelineStage;
  message: string;
  stepIndex?: number; // 1 to 5
  data?: {
    keywords?: string[];
    understanding?: UnderstandingResult;
    searchCount?: number;
    triagedCount?: number;
    fetchingUrl?: string;
    fetchedPage?: { url: string; status: "ok" | "thin" | "failed"; chars: number; sourceName?: string };
    matchedCount?: number;
    opportunities?: Opportunity[];
    sources?: SourceReport[];
    error?: string;
  };
}
