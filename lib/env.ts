import fs from "fs";
import path from "path";

// In-memory cache for parsed .env.local values
let cachedLocalEnv: Record<string, string> | null = null;

function loadLocalEnvFile(): Record<string, string> {
  if (cachedLocalEnv !== null) {
    return cachedLocalEnv;
  }

  const result: Record<string, string> = {};
  try {
    const envPath = path.resolve(process.cwd(), ".env.local");
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, "utf-8");
      const lines = content.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx !== -1) {
          const key = trimmed.slice(0, eqIdx).trim();
          let val = trimmed.slice(eqIdx + 1).trim();
          // Remove surrounding quotes if any
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          if (key && val) {
            result[key] = val;
          }
        }
      }
    }
  } catch (e) {
    // Non-fatal, e.g. on serverless environments where local file system may differ
  }

  cachedLocalEnv = result;
  return result;
}

/**
 * Get environment variable with .env.local having priority over stale process.env in local dev,
 * while seamlessly falling back to process.env in production (e.g. Vercel deployment).
 */
export function getEnv(key: string, defaultValue = ""): string {
  const localMap = loadLocalEnvFile();
  if (localMap[key] && localMap[key].trim() !== "") {
    return localMap[key].trim();
  }

  const sysVal = process.env[key];
  if (sysVal && sysVal.trim() !== "") {
    return sysVal.trim();
  }

  return defaultValue;
}
