import fs from "fs";
import path from "path";
import { TRUSTED_SOURCES } from "../config/sources";

// Load .env.local manually if not in environment
function loadEnv() {
  const envPath = path.resolve(process.cwd(), ".env.local");
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, "utf-8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const [key, ...valParts] = trimmed.split("=");
      if (key && valParts.length > 0 && !process.env[key.trim()]) {
        process.env[key.trim()] = valParts.join("=").trim();
      }
    }
  }
}

loadEnv();

const FETCH_API_URL = "https://api.fetch.tinyfish.ai";

interface FetchResult {
  name: string;
  url: string;
  status: "ok" | "thin" | "failed";
  chars: number;
  preview: string;
}

async function testAllSources() {
  const apiKey = process.env.TINYFISH_API_KEY;
  if (!apiKey || apiKey.includes("your_tinyfish_api_key")) {
    console.error("Error: TINYFISH_API_KEY is not set in .env.local or environment.");
    process.exit(1);
  }

  console.log("================================================================================");
  console.log("Opportunity Radar — Testing All 20 Trusted Sources via TinyFish Fetch API");
  console.log("================================================================================");
  console.log(`Found ${TRUSTED_SOURCES.length} sources to verify...\n`);

  const urls = TRUSTED_SOURCES.map((s) => s.url);
  const sourceByUrl = new Map(TRUSTED_SOURCES.map((s) => [s.url, s]));

  // TinyFish fetch batches of max 10 URLs
  const batches: string[][] = [];
  for (let i = 0; i < urls.length; i += 10) {
    batches.push(urls.slice(i, i + 10));
  }

  const results: FetchResult[] = [];

  for (let bIndex = 0; bIndex < batches.length; bIndex++) {
    const batch = batches[bIndex];
    console.log(`Fetching batch ${bIndex + 1}/${batches.length} (${batch.length} URLs)...`);

    try {
      const res = await fetch(FETCH_API_URL, {
        method: "POST",
        headers: {
          "X-API-Key": apiKey,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ urls: batch }),
      });

      if (!res.ok) {
        throw new Error(`TinyFish Fetch returned HTTP ${res.status}: ${res.statusText}`);
      }

      const data = await res.json();
      const items: any[] = Array.isArray(data)
        ? data
        : Array.isArray(data?.results)
        ? data.results
        : Array.isArray(data?.contents)
        ? data.contents
        : [];

      const itemMap = new Map<string, any>();
      for (const item of items) {
        if (item && item.url) {
          itemMap.set(item.url, item);
        }
      }

      for (const url of batch) {
        const source = sourceByUrl.get(url)!;
        const item = itemMap.get(url);

        if (item) {
          const text = (item.text || item.content || item.markdown || "").replace(/\s+/g, " ").trim();
          const chars = text.length;
          const status = chars >= 500 ? "ok" : "thin";
          const preview = text.slice(0, 120);

          results.push({
            name: source.name,
            url,
            status,
            chars,
            preview,
          });
        } else {
          results.push({
            name: source.name,
            url,
            status: "failed",
            chars: 0,
            preview: "(No content returned or error reported)",
          });
        }
      }
    } catch (err: any) {
      console.error(`Batch ${bIndex + 1} failed:`, err.message);
      for (const url of batch) {
        const source = sourceByUrl.get(url)!;
        results.push({
          name: source.name,
          url,
          status: "failed",
          chars: 0,
          preview: `(Fetch error: ${err.message})`,
        });
      }
    }
  }

  console.log("\n================================================================================");
  console.log("RESULTS TABLE");
  console.log("================================================================================");

  // Print formatted table
  console.table(
    results.map((r) => ({
      "Source Name": r.name,
      Status: r.status.toUpperCase(),
      Characters: r.chars,
      "First 120 Characters": r.preview,
    }))
  );

  const okCount = results.filter((r) => r.status === "ok").length;
  const thinCount = results.filter((r) => r.status === "thin").length;
  const failedCount = results.filter((r) => r.status === "failed").length;

  console.log("--------------------------------------------------------------------------------");
  console.log(`Summary: ${okCount} OK (>=500 chars) | ${thinCount} THIN (<500 chars) | ${failedCount} FAILED`);
  console.log("Note: Sources with heavy JavaScript (e.g. Unstop, DoraHacks) may return thin text");
  console.log("with standard Fetch and are prime candidates for TinyFish Agent API in future updates.");
  console.log("================================================================================\n");
}

testAllSources().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
