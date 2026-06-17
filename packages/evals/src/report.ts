import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EvalRunReport, PromptComparisonReport } from "./runner.js";

export async function writeEvalReport(input: {
  readonly report: EvalRunReport;
  readonly outputDir: string;
}): Promise<{ readonly jsonPath: string; readonly markdownPath: string }> {
  await mkdir(input.outputDir, { recursive: true });
  const jsonPath = join(input.outputDir, `${input.report.runId}.json`);
  const markdownPath = join(input.outputDir, `${input.report.runId}.md`);
  await Promise.all([
    writeFile(jsonPath, `${JSON.stringify(input.report, null, 2)}\n`, "utf8"),
    writeFile(markdownPath, renderMarkdownReport(input.report), "utf8")
  ]);
  return { jsonPath, markdownPath };
}

export async function writePromptComparisonReport(input: {
  readonly report: PromptComparisonReport;
  readonly outputDir: string;
}): Promise<{ readonly jsonPath: string; readonly markdownPath: string }> {
  await mkdir(input.outputDir, { recursive: true });
  const jsonPath = join(input.outputDir, `${input.report.comparisonId}.json`);
  const markdownPath = join(input.outputDir, `${input.report.comparisonId}.md`);
  await Promise.all([
    writeFile(jsonPath, `${JSON.stringify(input.report, null, 2)}\n`, "utf8"),
    writeFile(markdownPath, renderPromptComparisonMarkdown(input.report), "utf8")
  ]);
  return { jsonPath, markdownPath };
}

export function renderMarkdownReport(report: EvalRunReport): string {
  const lines = [
    `# Clip Selection Eval Report`,
    "",
    `- Run ID: ${report.runId}`,
    `- Created: ${report.createdAt}`,
    `- Prompt: ${report.promptVersion}`,
    `- Provider: ${report.provider}`,
    `- Model: ${report.model}`,
    `- Fixtures: ${String(report.fixtureCount)}`,
    `- Average score: ${report.averageScore.toFixed(2)}`,
    ""
  ];

  for (const result of report.results) {
    lines.push(
      `## ${result.fixtureId}`,
      "",
      `- Sermon ID: ${result.sermonId}`,
      `- Input hash: ${result.inputHash}`,
      `- Output hash: ${result.outputMetadata?.outputHash ?? "n/a"}`,
      `- Average score: ${result.averageScore.toFixed(2)}`,
      `- Validation failures: ${String(result.validationFailures.length)}`,
      ""
    );

    for (const score of result.scores) {
      lines.push(
        `### Clip: ${score.clipId}`,
        "",
        `Average: ${score.averageScore.toFixed(2)}`,
        "",
        "| Dimension | Score | Reason |",
        "| --- | ---: | --- |"
      );
      for (const dimensionScore of score.scores) {
        lines.push(
          `| ${dimensionScore.dimension} | ${dimensionScore.score.toFixed(1)} | ${escapeTableText(dimensionScore.reason)} |`
        );
      }
      lines.push("");
    }
  }

  return `${lines.join("\n")}\n`;
}

export function renderPromptComparisonMarkdown(report: PromptComparisonReport): string {
  const lines = [
    "# Prompt Comparison Report",
    "",
    `- Comparison ID: ${report.comparisonId}`,
    `- Created: ${report.createdAt}`,
    `- Provider: ${report.provider}`,
    `- Model: ${report.model}`,
    `- Fixtures: ${String(report.fixtureCount)}`,
    `- Best prompt: ${report.bestPromptVersion ?? "n/a"}`,
    "",
    "| Prompt | Average score | Validation failures | Run ID |",
    "| --- | ---: | ---: | --- |"
  ];

  for (const entry of report.entries) {
    lines.push(
      `| ${entry.promptVersion} | ${entry.averageScore.toFixed(2)} | ${String(entry.validationFailureCount)} | ${entry.runId} |`
    );
  }

  lines.push("");
  return `${lines.join("\n")}\n`;
}

function escapeTableText(text: string): string {
  return text.replaceAll("|", "\\|");
}
