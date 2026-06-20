import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createFileJobStore } from "./job-store.js";
import { createLogger } from "./logger.js";
import { createServer } from "./server.js";

loadEnvFile(resolve(process.cwd(), "../../.env"));

const port = Number.parseInt(process.env["PORT"] ?? "4000", 10);
const dataDir = process.env["FAITHFLIPS_DATA_DIR"] ?? resolve(process.cwd(), ".faithflips-data");
const jobStorePath = process.env["FAITHFLIPS_JOB_STORE_PATH"] ?? resolve(dataDir, "jobs.json");
const publicBaseUrl =
  process.env["FAITHFLIPS_PUBLIC_BASE_URL"] ?? `http://127.0.0.1:${String(port)}`;
const srcDir = fileURLToPath(new URL(".", import.meta.url));
const webDistDir =
  process.env["FAITHFLIPS_WEB_DIST_DIR"] ?? resolve(srcDir, "../../../apps/web/dist");
const logger = createLogger();

const server = createServer({
  store: createFileJobStore({ filePath: jobStorePath }),
  dataDir,
  publicBaseUrl,
  webDistDir,
  logger
});

server.listen(port, () => {
  logger({ event: "api_started", port, jobStorePath, publicBaseUrl });
});

function loadEnvFile(path: string): void {
  try {
    const content = readFileSync(path, "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }
      const separatorIndex = trimmed.indexOf("=");
      if (separatorIndex === -1) {
        continue;
      }
      const key = trimmed.slice(0, separatorIndex).trim();
      const value = trimmed
        .slice(separatorIndex + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch {
    // Local dev can still use exported environment variables.
  }
}
