import { fileURLToPath } from "node:url";
import { clipSelectionPrompts } from "@faithflips/prompts";
import { dirname, join, resolve } from "node:path";
import { loadEvalFixtures } from "./fixture.js";
import { writeEvalReport, writePromptComparisonReport } from "./report.js";
import { runClipSelectionPromptComparison } from "./runner.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixturesDir = process.argv[2] ? resolve(process.argv[2]) : join(packageRoot, "fixtures");
const outputDir = process.argv[3] ? resolve(process.argv[3]) : join(packageRoot, "reports");

const fixtures = await loadEvalFixtures(fixturesDir);
const comparison = await runClipSelectionPromptComparison({
  fixtures,
  prompts: clipSelectionPrompts
});
const runPaths = await Promise.all(
  comparison.reports.map((report) => writeEvalReport({ report, outputDir }))
);
const comparisonPaths = await writePromptComparisonReport({ report: comparison, outputDir });

console.log(
  JSON.stringify({
    event: "prompt_comparison_report_written",
    comparisonId: comparison.comparisonId,
    fixtureCount: comparison.fixtureCount,
    bestPromptVersion: comparison.bestPromptVersion,
    reports: runPaths,
    jsonPath: comparisonPaths.jsonPath,
    markdownPath: comparisonPaths.markdownPath
  })
);
