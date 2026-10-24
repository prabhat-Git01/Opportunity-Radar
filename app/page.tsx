"use client";

import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  Opportunity,
  OpportunityCategory,
  OpportunityType,
  PipelineProgressEvent,
  SourceReport,
} from "@/lib/types";
import { TRUSTED_SOURCES } from "@/config/sources";
import {
  Search,
  Sparkles,
  MapPin,
  Calendar,
  Clock,
  ExternalLink,
  ChevronDown,
  ChevronUp,
  Award,
  Layers,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Moon,
  Sun,
  Filter,
  ArrowUpDown,
  BookOpen,
  Briefcase,
  Code2,
  Trophy,
  GraduationCap,
  Globe,
  Radio,
} from "lucide-react";

const CATEGORIES: OpportunityCategory[] = [
  "Internships",
  "Hackathons",
  "Competitions",
  "Scholarships",
  "Fellowships",
  "Open Source",
];

const PRESETS = [
  {
    label: "Paid AI/ML internship, 3rd year B.Tech",
    lookingFor: "Paid AI/ML internship, remote or hybrid with monthly stipend",
    profile:
      "3rd year B.Tech Computer Science, Bangalore. Skills: Python, PyTorch, Scikit-learn, LangChain, SQL. Looking for research or engineering roles.",
    category: "Internships",
  },
  {
    label: "Hackathons for beginners in web dev",
    lookingFor: "Beginner-friendly online web dev hackathons with cash prizes and swag",
    profile:
      "2nd year BCA student, Delhi. Skills: React, Next.js, Node.js, Tailwind CSS, Git. Looking for team competitions.",
    category: "Hackathons",
  },
  {
    label: "Scholarships for engineering students",
    lookingFor: "Merit and need-based scholarships for Indian engineering undergraduate students",
    profile:
      "1st year B.Tech Electrical Engineering, Tier-2 Government College. Annual family income < 4 LPA, 92% in 12th CBSE.",
    category: "Scholarships",
  },
];

export default function OpportunityRadarPage() {
  // Theme state
  const [darkMode, setDarkMode] = useState(false);

  // Form inputs
  const [lookingFor, setLookingFor] = useState(
    "Paid AI/ML internship, remote or hybrid with stipend"
  );
  const [profile, setProfile] = useState(
    "3rd year B.Tech CSE student from Bangalore. Skills: Python, Next.js, PyTorch, GenAI. Looking for summer 2026 roles."
  );
  const [selectedCategory, setSelectedCategory] = useState<string>("All");

  // Pipeline execution state
  const [isSearching, setIsSearching] = useState(false);
  const [currentStep, setCurrentStep] = useState<number>(0);
  const [statusMessage, setStatusMessage] = useState<string>("");
  const [extractedKeywords, setExtractedKeywords] = useState<string[]>([]);
  const [fetchedPagesPills, setFetchedPagesPills] = useState<
    Array<{ url: string; status: "ok" | "thin" | "failed"; chars: number; sourceName?: string }>
  >([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Results
  const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
  const [sourceReports, setSourceReports] = useState<SourceReport[]>([]);

  // Filtering & Sorting
  const [typeFilter, setTypeFilter] = useState<string>("All");
  const [closingSoonOnly, setClosingSoonOnly] = useState<boolean>(false);
  const [sortBy, setSortBy] = useState<"fit" | "deadline">("fit");
  const [sourcesOpen, setSourcesOpen] = useState(false);

  const resultsRef = useRef<HTMLDivElement>(null);

  // Initialize theme
  useEffect(() => {
    const isDark =
      window.matchMedia &&
      window.matchMedia("(prefers-color-scheme: dark)").matches;
    setDarkMode(isDark);
    if (isDark) {
      document.documentElement.classList.add("dark");
    }
  }, []);

  const toggleDarkMode = () => {
    setDarkMode((prev) => {
      const next = !prev;
      if (next) {
        document.documentElement.classList.add("dark");
      } else {
        document.documentElement.classList.remove("dark");
      }
      return next;
    });
  };

  const handleApplyPreset = (preset: (typeof PRESETS)[0]) => {
    setLookingFor(preset.lookingFor);
    setProfile(preset.profile);
    setSelectedCategory(preset.category);
  };

  // Start radar pipeline via Server-Sent Events
  const handleStartSearch = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (isSearching) return;

    setIsSearching(true);
    setErrorMessage(null);
    setCurrentStep(1);
    setStatusMessage("Connecting to Opportunity Radar pipeline...");
    setExtractedKeywords([]);
    setFetchedPagesPills([]);
    setOpportunities([]);

    try {
      const res = await fetch("/api/radar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lookingFor,
          profile,
          selectedCategories: selectedCategory === "All" ? ["All"] : [selectedCategory],
        }),
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || `Server returned error ${res.status}`);
      }

      if (!res.body) {
        throw new Error("No response body received from server");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;

          const jsonStr = trimmed.slice(5).trim();
          if (!jsonStr) continue;

          try {
            const event: PipelineProgressEvent = JSON.parse(jsonStr);

            if (event.stepIndex) {
              setCurrentStep(event.stepIndex);
            }
            if (event.message) {
              setStatusMessage(event.message);
            }

            if (event.stage === "keywords" && event.data?.keywords) {
              setExtractedKeywords(event.data.keywords);
            }

            if (event.stage === "fetching" && event.data?.fetchedPage) {
              setFetchedPagesPills((prev) => {
                if (prev.some((p) => p.url === event.data?.fetchedPage?.url)) {
                  return prev;
                }
                return [...prev, event.data!.fetchedPage!];
              });
            }

            if (event.stage === "done" && event.data) {
              if (event.data.opportunities) {
                setOpportunities(event.data.opportunities);
              }
              if (event.data.sources) {
                setSourceReports(event.data.sources);
              }
              setCurrentStep(5);
              setIsSearching(false);

              // Smooth scroll to results
              setTimeout(() => {
                resultsRef.current?.scrollIntoView({ behavior: "smooth" });
              }, 300);
            }

            if (event.stage === "error") {
              setErrorMessage(event.message || "An error occurred");
              setIsSearching(false);
            }
          } catch (jsonErr) {
            console.error("Failed to parse SSE event:", jsonStr, jsonErr);
          }
        }
      }
    } catch (err: any) {
      console.error("Search pipeline error:", err);
      let friendly = err.message || "An unexpected error occurred";
      if (friendly.includes("API key")) {
        friendly = "Your API key looks wrong";
      } else if (friendly.includes("Too many requests") || friendly.includes("429")) {
        friendly = "Too many requests, wait a minute";
      } else if (friendly.includes("free limit") || friendly.includes("402")) {
        friendly = "Daily free limit reached";
      } else if (friendly.includes("reach TinyFish") || friendly.includes("fetch failed")) {
        friendly = "Couldn't reach TinyFish";
      }
      setErrorMessage(friendly);
    } finally {
      setIsSearching(false);
    }
  };

  // Helper: check if deadline is within 7 days
  const isClosingSoon = (deadlineIso: string | null): boolean => {
    if (!deadlineIso) return false;
    const deadline = new Date(deadlineIso).getTime();
    const now = Date.now();
    const diffDays = (deadline - now) / (1000 * 60 * 60 * 24);
    return diffDays >= 0 && diffDays <= 7;
  };

  // Filter and sort opportunities
  const filteredOpportunities = useMemo(() => {
    return opportunities
      .filter((opp) => {
        if (typeFilter !== "All" && opp.type !== typeFilter) {
          return false;
        }
        if (closingSoonOnly && !isClosingSoon(opp.deadline_iso)) {
          return false;
        }
        return true;
      })
      .sort((a, b) => {
        if (sortBy === "fit") {
          if (b.fit_score !== a.fit_score) return b.fit_score - a.fit_score;
          if (a.deadline_iso && b.deadline_iso) {
            return a.deadline_iso.localeCompare(b.deadline_iso);
          }
          return 0;
        } else {
          // Sort by deadline
          if (a.deadline_iso && b.deadline_iso) {
            return a.deadline_iso.localeCompare(b.deadline_iso);
          }
          if (a.deadline_iso && !b.deadline_iso) return -1;
          if (!a.deadline_iso && b.deadline_iso) return 1;
          return b.fit_score - a.fit_score;
        }
      });
  }, [opportunities, typeFilter, closingSoonOnly, sortBy]);

  // Color styles per opportunity type
  const getTypeBadgeStyle = (type: OpportunityType) => {
    switch (type) {
      case "Internship":
        return "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/60 dark:text-blue-300 dark:border-blue-800";
      case "Hackathon":
        return "bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-950/60 dark:text-purple-300 dark:border-purple-800";
      case "Competition":
        return "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/60 dark:text-amber-300 dark:border-amber-800";
      case "Scholarship":
        return "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/60 dark:text-emerald-300 dark:border-emerald-800";
      case "Fellowship":
        return "bg-cyan-50 text-cyan-700 border-cyan-200 dark:bg-cyan-950/60 dark:text-cyan-300 dark:border-cyan-800";
      case "Open Source":
        return "bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/60 dark:text-rose-300 dark:border-rose-800";
      default:
        return "bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700";
    }
  };

  const getCategoryIcon = (category: string) => {
    switch (category) {
      case "Internships":
        return <Briefcase className="w-4 h-4 mr-1.5" />;
      case "Hackathons":
        return <Code2 className="w-4 h-4 mr-1.5" />;
      case "Competitions":
        return <Trophy className="w-4 h-4 mr-1.5" />;
      case "Scholarships":
        return <GraduationCap className="w-4 h-4 mr-1.5" />;
      case "Fellowships":
        return <BookOpen className="w-4 h-4 mr-1.5" />;
      case "Open Source":
        return <Globe className="w-4 h-4 mr-1.5" />;
      default:
        return <Sparkles className="w-4 h-4 mr-1.5" />;
    }
  };

  const getFitCircleColor = (score: number) => {
    if (score >= 8) {
      return "text-emerald-600 bg-emerald-50 border-emerald-300 dark:text-emerald-400 dark:bg-emerald-950/60 dark:border-emerald-700";
    }
    if (score >= 5) {
      return "text-amber-600 bg-amber-50 border-amber-300 dark:text-amber-400 dark:bg-amber-950/60 dark:border-amber-700";
    }
    return "text-slate-500 bg-slate-50 border-slate-300 dark:text-slate-400 dark:bg-slate-800 dark:border-slate-700";
  };

  return (
    <div className="min-h-screen flex flex-col transition-colors duration-200">
      {/* Top Navbar */}
      <header className="sticky top-0 z-40 backdrop-blur-md bg-white/80 dark:bg-[#0b0f19]/80 border-b border-slate-200/80 dark:border-slate-800/80">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-indigo-600 to-indigo-400 flex items-center justify-center text-white shadow-md shadow-indigo-500/20">
              <Radio className="w-5 h-5 animate-pulse" />
            </div>
            <div>
              <span className="font-bold text-lg tracking-tight bg-gradient-to-r from-indigo-600 via-indigo-500 to-indigo-700 dark:from-indigo-400 dark:to-indigo-300 bg-clip-text text-transparent">
                Opportunity Radar
              </span>
              <span className="hidden sm:inline-block ml-2 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider bg-indigo-50 dark:bg-indigo-950 text-indigo-600 dark:text-indigo-400 rounded-full border border-indigo-200 dark:border-indigo-800">
                Live India
              </span>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={() => setSourcesOpen(!sourcesOpen)}
              className="text-xs font-medium px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 flex items-center gap-1.5 transition"
            >
              <Layers className="w-3.5 h-3.5 text-indigo-500" />
              <span>20 Trusted Sources</span>
            </button>
            <button
              onClick={toggleDarkMode}
              className="p-2 rounded-lg border border-slate-200 dark:border-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 transition"
              aria-label="Toggle dark mode"
            >
              {darkMode ? <Sun className="w-4 h-4 text-amber-400" /> : <Moon className="w-4 h-4 text-indigo-600" />}
            </button>
          </div>
        </div>
      </header>

      {/* Main Container */}
      <main className="flex-1 max-w-6xl w-full mx-auto px-4 sm:px-6 py-8 sm:py-12">
        {/* Hero Section */}
        <div className="text-center mb-10 sm:mb-12">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-indigo-50 dark:bg-indigo-950/60 border border-indigo-200/80 dark:border-indigo-800/80 text-indigo-700 dark:text-indigo-300 text-xs font-semibold uppercase tracking-wider mb-4">
            <Sparkles className="w-3.5 h-3.5" />
            Direct Live Web Extraction
          </div>
          <h1 className="text-3xl sm:text-5xl font-extrabold tracking-tight text-slate-900 dark:text-white mb-4">
            Opportunity Radar
          </h1>
          <p className="text-base sm:text-lg text-slate-600 dark:text-slate-300 max-w-2xl mx-auto">
            Live opportunities from 20 trusted sources, matched to you
          </p>
        </div>

        {/* Input Form Card */}
        <div className="bg-white dark:bg-[#121827] rounded-2xl border border-slate-200/80 dark:border-slate-800 shadow-xl shadow-slate-200/40 dark:shadow-none p-5 sm:p-8 mb-8">
          <form onSubmit={handleStartSearch} className="space-y-6">
            {/* Category selection chips */}
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-2.5">
                Category
              </label>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setSelectedCategory("All")}
                  className={`px-3 py-1.5 rounded-xl text-xs sm:text-sm font-medium transition-all ${
                    selectedCategory === "All"
                      ? "bg-indigo-600 text-white shadow-md shadow-indigo-600/30"
                      : "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700"
                  }`}
                >
                  All (AI Decides)
                </button>
                {CATEGORIES.map((cat) => (
                  <button
                    key={cat}
                    type="button"
                    onClick={() => setSelectedCategory(cat)}
                    className={`inline-flex items-center px-3 py-1.5 rounded-xl text-xs sm:text-sm font-medium transition-all ${
                      selectedCategory === cat
                        ? "bg-indigo-600 text-white shadow-md shadow-indigo-600/30"
                        : "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700"
                    }`}
                  >
                    {getCategoryIcon(cat)}
                    {cat}
                  </button>
                ))}
              </div>
            </div>

            {/* Inputs Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-2">
                  What are you looking for?
                </label>
                <textarea
                  rows={3}
                  value={lookingFor}
                  onChange={(e) => setLookingFor(e.target.value)}
                  placeholder="e.g. Paid ML internship, remote, or AI hackathons with cash prizes"
                  className="w-full px-4 py-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50/50 dark:bg-slate-900/50 text-slate-900 dark:text-white placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 text-sm resize-none"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-2">
                  About you (Student Profile)
                </label>
                <textarea
                  rows={3}
                  value={profile}
                  onChange={(e) => setProfile(e.target.value)}
                  placeholder="e.g. 3rd year B.Tech CSE, Mumbai. Skills: Python, Docker, Next.js. Interested in cloud & backend."
                  className="w-full px-4 py-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50/50 dark:bg-slate-900/50 text-slate-900 dark:text-white placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 text-sm resize-none"
                />
              </div>
            </div>

            {/* Preset example buttons */}
            <div>
              <span className="text-xs text-slate-500 dark:text-slate-400 mr-2 font-medium">
                Try examples:
              </span>
              <div className="inline-flex flex-wrap gap-2 mt-2 sm:mt-0">
                {PRESETS.map((p, idx) => (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => handleApplyPreset(p)}
                    className="text-xs bg-indigo-50 hover:bg-indigo-100 dark:bg-indigo-950/60 dark:hover:bg-indigo-900/80 text-indigo-700 dark:text-indigo-300 px-2.5 py-1 rounded-lg border border-indigo-200/60 dark:border-indigo-800 transition"
                  >
                    ✨ {p.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Submit Button */}
            <div className="pt-2">
              <button
                type="submit"
                disabled={isSearching}
                className="w-full sm:w-auto min-w-[200px] inline-flex items-center justify-center gap-2.5 px-6 py-3.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 text-white font-semibold text-sm sm:text-base shadow-lg shadow-indigo-600/30 transition disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
              >
                {isSearching ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" />
                    <span>Scanning Radar...</span>
                  </>
                ) : (
                  <>
                    <Search className="w-5 h-5" />
                    <span>Find opportunities</span>
                  </>
                )}
              </button>
            </div>
          </form>
        </div>

        {/* Friendly Error Banner */}
        {errorMessage && (
          <div className="mb-8 p-4 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 flex items-start gap-3 shadow-sm">
            <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5 text-red-500" />
            <div className="flex-1 text-sm">
              <div className="font-semibold text-red-800 dark:text-red-200">
                {errorMessage}
              </div>
              <p className="mt-1 text-xs text-red-600 dark:text-red-400">
                {errorMessage.includes("API key")
                  ? "Please verify that your TINYFISH_API_KEY and GEMINI_API_KEY are configured in .env.local."
                  : errorMessage.includes("Too many requests")
                  ? "TinyFish rate limit exceeded. Please wait a moment and try again."
                  : errorMessage.includes("free limit")
                  ? "Your daily free tier has been reached for today."
                  : "Please check your network connection or server status."}
              </p>
            </div>
          </div>
        )}

        {/* Live Progress Tracker (SSE) */}
        {(isSearching || currentStep > 0) && (
          <div className="bg-white dark:bg-[#121827] rounded-2xl border border-slate-200/80 dark:border-slate-800 p-5 sm:p-6 mb-8 shadow-sm">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Radio className={`w-4 h-4 ${isSearching ? "text-indigo-600 animate-pulse" : "text-emerald-500"}`} />
                <h3 className="font-semibold text-sm text-slate-900 dark:text-white">
                  Radar Progress
                </h3>
              </div>
              <span className="text-xs text-slate-500 dark:text-slate-400">
                {isSearching ? "Live Scanning" : "Scan Complete"}
              </span>
            </div>

            {/* Stepper */}
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5 mb-5">
              {[
                { num: 1, label: "Understanding you" },
                { num: 2, label: "Searching trusted sites" },
                { num: 3, label: "Reading pages" },
                { num: 4, label: "Matching" },
                { num: 5, label: "Done" },
              ].map((step) => {
                const isComplete = currentStep > step.num || (!isSearching && currentStep === 5);
                const isCurrent = currentStep === step.num && isSearching;
                return (
                  <div
                    key={step.num}
                    className={`flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-medium border transition-all ${
                      isComplete
                        ? "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800"
                        : isCurrent
                        ? "bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-950/60 dark:text-indigo-300 dark:border-indigo-800 animate-pulse"
                        : "bg-slate-50 text-slate-400 border-slate-200 dark:bg-slate-900/40 dark:text-slate-500 dark:border-slate-800"
                    }`}
                  >
                    {isComplete ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 flex-shrink-0" />
                    ) : isCurrent ? (
                      <Loader2 className="w-4 h-4 animate-spin text-indigo-600 flex-shrink-0" />
                    ) : (
                      <div className="w-4 h-4 rounded-full border border-slate-300 dark:border-slate-700 flex items-center justify-center text-[10px]">
                        {step.num}
                      </div>
                    )}
                    <span className="truncate">{step.label}</span>
                  </div>
                );
              })}
            </div>

            {/* Status message */}
            <div className="text-xs text-slate-600 dark:text-slate-300 font-medium mb-3">
              {statusMessage}
            </div>

            {/* Extracted keyword chips */}
            {extractedKeywords.length > 0 && (
              <div className="mt-3 pt-3 border-t border-slate-100 dark:border-slate-800/80">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 block mb-2">
                  Keywords Understood by AI:
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {extractedKeywords.map((kw, i) => (
                    <span
                      key={i}
                      className="px-2.5 py-0.5 rounded-full text-xs bg-indigo-50 text-indigo-700 dark:bg-indigo-950/80 dark:text-indigo-300 border border-indigo-200/80 dark:border-indigo-800 font-medium"
                    >
                      #{kw}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Page reading pills */}
            {fetchedPagesPills.length > 0 && (
              <div className="mt-3 pt-3 border-t border-slate-100 dark:border-slate-800/80">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 block mb-2">
                  Live Pages Processed ({fetchedPagesPills.length}):
                </span>
                <div className="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto pr-1">
                  {fetchedPagesPills.map((pill, i) => (
                    <span
                      key={i}
                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] border ${
                        pill.status === "ok"
                          ? "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-300 dark:border-emerald-800"
                          : pill.status === "thin"
                          ? "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/50 dark:text-amber-300 dark:border-amber-800"
                          : "bg-red-50 text-red-700 border-red-200 dark:bg-red-950/50 dark:text-red-300 dark:border-red-800"
                      }`}
                      title={pill.url}
                    >
                      <span className="w-1.5 h-1.5 rounded-full bg-current" />
                      <span className="max-w-[150px] truncate">
                        {pill.sourceName || new URL(pill.url).hostname}
                      </span>
                      <span className="text-[9px] opacity-75">({pill.chars}c)</span>
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Collapsible Sources Panel */}
        <div className="mb-8 bg-white dark:bg-[#121827] rounded-2xl border border-slate-200/80 dark:border-slate-800 overflow-hidden shadow-sm">
          <button
            type="button"
            onClick={() => setSourcesOpen(!sourcesOpen)}
            className="w-full px-5 sm:px-6 py-4 flex items-center justify-between text-left hover:bg-slate-50/50 dark:hover:bg-slate-900/50 transition"
          >
            <div className="flex items-center gap-2.5">
              <Layers className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
              <span className="font-semibold text-sm text-slate-900 dark:text-white">
                Trusted Sources Network ({TRUSTED_SOURCES.length})
              </span>
              <span className="text-xs text-slate-500">
                (Internshala, Devfolio, Unstop, Buddy4Study, GSoC, etc.)
              </span>
            </div>
            {sourcesOpen ? (
              <ChevronUp className="w-4 h-4 text-slate-500" />
            ) : (
              <ChevronDown className="w-4 h-4 text-slate-500" />
            )}
          </button>

          {sourcesOpen && (
            <div className="px-5 sm:px-6 pb-5 pt-1 border-t border-slate-100 dark:border-slate-800/80">
              <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">
                Real-time status of trusted portals. Status updates after running a search:
                <span className="inline-flex items-center gap-1 ml-2 text-emerald-600"><span className="w-2 h-2 rounded-full bg-emerald-500 inline-block"/> Ok</span>
                <span className="inline-flex items-center gap-1 ml-2 text-amber-600"><span className="w-2 h-2 rounded-full bg-amber-500 inline-block"/> Thin text</span>
                <span className="inline-flex items-center gap-1 ml-2 text-red-600"><span className="w-2 h-2 rounded-full bg-red-500 inline-block"/> Failed</span>
                <span className="inline-flex items-center gap-1 ml-2 text-slate-400"><span className="w-2 h-2 rounded-full bg-slate-300 inline-block"/> Unused</span>
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-2.5">
                {TRUSTED_SOURCES.map((src) => {
                  const report = sourceReports.find((r) => r.domain === src.domain);
                  const status = report?.status || "unused";
                  const foundCount = report?.opportunitiesFound || 0;

                  return (
                    <div
                      key={src.domain}
                      className="p-2.5 rounded-xl border border-slate-200 dark:border-slate-800/80 bg-slate-50/50 dark:bg-slate-900/40 text-xs flex items-center justify-between"
                    >
                      <div className="flex items-center gap-2 truncate">
                        <span
                          className={`w-2 h-2 rounded-full flex-shrink-0 ${
                            status === "ok"
                              ? "bg-emerald-500"
                              : status === "thin"
                              ? "bg-amber-500"
                              : status === "failed"
                              ? "bg-red-500"
                              : "bg-slate-300 dark:bg-slate-700"
                          }`}
                        />
                        <div className="truncate">
                          <a
                            href={src.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-medium text-slate-800 dark:text-slate-200 hover:text-indigo-600 truncate block"
                          >
                            {src.name}
                          </a>
                          <span className="text-[10px] text-slate-400 block truncate">
                            {src.domain}
                          </span>
                        </div>
                      </div>
                      {foundCount > 0 && (
                        <span className="px-1.5 py-0.5 text-[10px] rounded-full bg-indigo-50 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-300 font-semibold border border-indigo-200 dark:border-indigo-800">
                          +{foundCount}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Results Area */}
        <div ref={resultsRef} className="space-y-6">
          {/* Results Header and Filters */}
          {opportunities.length > 0 && (
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-200 dark:border-slate-800">
              <div>
                <h2 className="text-xl sm:text-2xl font-bold text-slate-900 dark:text-white">
                  Opportunities Found
                </h2>
                <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400">
                  Showing {filteredOpportunities.length} of {opportunities.length} live verified opportunities
                </p>
              </div>

              {/* Filters Controls */}
              <div className="flex flex-wrap items-center gap-2.5">
                {/* Type Filter */}
                <div className="flex items-center gap-1.5">
                  <Filter className="w-3.5 h-3.5 text-slate-400" />
                  <select
                    value={typeFilter}
                    onChange={(e) => setTypeFilter(e.target.value)}
                    className="text-xs px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 focus:outline-none"
                  >
                    <option value="All">All Types</option>
                    <option value="Internship">Internships</option>
                    <option value="Hackathon">Hackathons</option>
                    <option value="Competition">Competitions</option>
                    <option value="Scholarship">Scholarships</option>
                    <option value="Fellowship">Fellowships</option>
                    <option value="Open Source">Open Source</option>
                  </select>
                </div>

                {/* Closing Soon Toggle */}
                <button
                  type="button"
                  onClick={() => setClosingSoonOnly(!closingSoonOnly)}
                  className={`text-xs px-2.5 py-1.5 rounded-lg border font-medium transition ${
                    closingSoonOnly
                      ? "bg-rose-50 text-rose-700 border-rose-300 dark:bg-rose-950/60 dark:text-rose-300 dark:border-rose-800"
                      : "bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-800"
                  }`}
                >
                  ⏳ Closing Soon (&le;7d)
                </button>

                {/* Sort Toggle */}
                <div className="flex items-center gap-1.5">
                  <ArrowUpDown className="w-3.5 h-3.5 text-slate-400" />
                  <select
                    value={sortBy}
                    onChange={(e) => setSortBy(e.target.value as "fit" | "deadline")}
                    className="text-xs px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 focus:outline-none"
                  >
                    <option value="fit">Sort: Best Match</option>
                    <option value="deadline">Sort: Nearest Deadline</option>
                  </select>
                </div>
              </div>
            </div>
          )}

          {/* Results Grid */}
          {filteredOpportunities.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              {filteredOpportunities.map((opp) => {
                const closingSoon = isClosingSoon(opp.deadline_iso);

                return (
                  <div
                    key={opp.id}
                    className="bg-white dark:bg-[#121827] rounded-2xl border border-slate-200/80 dark:border-slate-800/80 shadow-sm hover:shadow-md transition-all p-5 flex flex-col justify-between group"
                  >
                    <div>
                      {/* Top Badges Row */}
                      <div className="flex items-start justify-between gap-3 mb-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={`px-2.5 py-1 rounded-lg text-xs font-semibold border ${getTypeBadgeStyle(
                              opp.type
                            )}`}
                          >
                            {opp.type}
                          </span>
                          <span className="text-xs px-2 py-0.5 rounded-md bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 font-medium">
                            {opp.mode}
                          </span>
                        </div>

                        {/* Fit Score Circle */}
                        <div
                          className={`w-9 h-9 rounded-full flex items-center justify-center font-bold text-xs border ${getFitCircleColor(
                            opp.fit_score
                          )} flex-shrink-0 shadow-sm`}
                          title={`Profile Match Score: ${opp.fit_score}/10`}
                        >
                          {opp.fit_score}
                          <span className="text-[8px] font-normal">/10</span>
                        </div>
                      </div>

                      {/* Title & Organization */}
                      <h3 className="font-bold text-base sm:text-lg text-slate-900 dark:text-white group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition mb-1 leading-snug">
                        {opp.title}
                      </h3>
                      <div className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-3 flex items-center gap-1.5">
                        <Award className="w-3.5 h-3.5 text-indigo-500" />
                        <span>{opp.organization}</span>
                        {opp.location && opp.location !== "Unknown" && (
                          <>
                            <span>•</span>
                            <MapPin className="w-3 h-3" />
                            <span>{opp.location}</span>
                          </>
                        )}
                      </div>

                      {/* Stipend / Prize & Eligibility */}
                      <div className="space-y-1.5 text-xs text-slate-600 dark:text-slate-300 mb-4 bg-slate-50/60 dark:bg-slate-900/40 p-3 rounded-xl border border-slate-100 dark:border-slate-800/60">
                        {opp.stipend_or_prize && (
                          <div className="flex items-center gap-1.5 font-semibold text-emerald-700 dark:text-emerald-400">
                            <span>💰 Stipend / Prize:</span>
                            <span>{opp.stipend_or_prize}</span>
                          </div>
                        )}
                        <div>
                          <span className="font-medium text-slate-500 dark:text-slate-400">
                            Eligibility:{" "}
                          </span>
                          <span>{opp.eligibility}</span>
                        </div>
                      </div>

                      {/* Why it fits (Direct to student) */}
                      {opp.why_it_fits && (
                        <p className="text-xs italic text-indigo-900 dark:text-indigo-200 bg-indigo-50/50 dark:bg-indigo-950/30 p-2.5 rounded-lg border border-indigo-100 dark:border-indigo-900/40 mb-3">
                          &ldquo;{opp.why_it_fits}&rdquo;
                        </p>
                      )}

                      {/* Matched Keywords */}
                      {opp.keyword_matches && opp.keyword_matches.length > 0 && (
                        <div className="flex flex-wrap gap-1 mb-4">
                          {opp.keyword_matches.map((kw, idx) => (
                            <span
                              key={idx}
                              className="text-[10px] px-2 py-0.5 rounded-md bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 font-medium"
                            >
                              {kw}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Card Footer */}
                    <div className="pt-3 border-t border-slate-100 dark:border-slate-800/80 flex items-center justify-between gap-2 mt-2">
                      <div className="flex flex-col">
                        <div className="flex items-center gap-1 text-xs">
                          <Calendar className="w-3 h-3 text-slate-400" />
                          <span
                            className={`font-semibold ${
                              closingSoon
                                ? "text-rose-600 dark:text-rose-400"
                                : opp.deadline_iso
                                ? "text-slate-700 dark:text-slate-200"
                                : "text-slate-400"
                            }`}
                          >
                            {opp.deadline_text}
                          </span>
                        </div>
                        {opp.source_name && (
                          <span className="text-[10px] text-slate-400 mt-0.5">
                            via {opp.source_name}
                          </span>
                        )}
                      </div>

                      <a
                        href={opp.link}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold shadow-sm shadow-indigo-600/20 transition flex-shrink-0"
                      >
                        <span>Apply / View</span>
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : opportunities.length > 0 ? (
            /* Empty state after filter */
            <div className="text-center py-12 bg-white dark:bg-[#121827] rounded-2xl border border-slate-200 dark:border-slate-800 p-8">
              <Clock className="w-10 h-10 text-slate-400 mx-auto mb-3" />
              <h3 className="text-base font-bold text-slate-800 dark:text-slate-200 mb-1">
                No matching opportunities found with current filters
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 max-w-sm mx-auto mb-4">
                Try resetting your type filter or turning off &ldquo;Closing Soon&rdquo;.
              </p>
              <button
                type="button"
                onClick={() => {
                  setTypeFilter("All");
                  setClosingSoonOnly(false);
                }}
                className="px-4 py-2 rounded-xl text-xs font-semibold bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800"
              >
                Reset Filters
              </button>
            </div>
          ) : currentStep === 5 && !isSearching ? (
            /* Friendly Empty State if 0 opportunities returned */
            <div className="text-center py-16 bg-white dark:bg-[#121827] rounded-2xl border border-slate-200 dark:border-slate-800 p-8">
              <Radio className="w-12 h-12 text-slate-300 dark:text-slate-700 mx-auto mb-3" />
              <h3 className="text-lg font-bold text-slate-800 dark:text-slate-200 mb-2">
                No active deadlines found right now
              </h3>
              <p className="text-sm text-slate-500 dark:text-slate-400 max-w-md mx-auto mb-5">
                We scanned trusted portals and filtered out expired cycles. Try broadening your keywords or selecting &ldquo;All&rdquo; categories.
              </p>
              <button
                type="button"
                onClick={() => {
                  setSelectedCategory("All");
                  setLookingFor("Internships, hackathons and scholarships for college students");
                }}
                className="px-5 py-2.5 rounded-xl text-xs sm:text-sm font-semibold bg-indigo-600 text-white shadow-md shadow-indigo-600/30"
              >
                Broaden Search
              </button>
            </div>
          ) : null}
        </div>
      </main>

      {/* Footer */}
      <footer className="mt-auto border-t border-slate-200/80 dark:border-slate-800/80 py-6 bg-white/50 dark:bg-[#0b0f19]/50 text-center text-xs text-slate-500">
        <p>Opportunity Radar • Built with Next.js, TinyFish API, and Gemini 2.5 Flash</p>
        <p className="mt-1 text-[11px] text-slate-400">
          Scraping live data from Internshala, Devfolio, Unstop, Buddy4Study, GSoC, AICTE, and 14 more portals.
        </p>
      </footer>
    </div>
  );
}
