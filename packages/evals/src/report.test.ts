import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  renderMarkdownReport,
  renderPromptComparisonMarkdown,
  writeEvalReport,
  writePromptComparisonReport
} from "./report.js";
import type { EvalRunReport, PromptComparisonReport } from "./runner.js";

describe("eval reports", () => {
  it("renders markdown and writes json plus markdown reports", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "faithflips-eval-"));
    const paths = await writeEvalReport({ report, outputDir });

    await expect(readFile(paths.jsonPath, "utf8")).resolves.toContain('"runId": "eval_test"');
    await expect(readFile(paths.markdownPath, "utf8")).resolves.toContain(
      "# Clip Selection Eval Report"
    );
  });

  it("includes summary fields in markdown", () => {
    expect(renderMarkdownReport(report)).toContain("- Average score: 4.50");
  });

  it("renders and writes prompt comparison reports", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "faithflips-comparison-"));
    const paths = await writePromptComparisonReport({ report: comparisonReport, outputDir });

    await expect(readFile(paths.jsonPath, "utf8")).resolves.toContain(
      '"comparisonId": "comparison_test"'
    );
    expect(renderPromptComparisonMarkdown(comparisonReport)).toContain("clip-selection-v2");
  });
});

const report: EvalRunReport = {
  runId: "eval_test",
  createdAt: "2026-01-05T00:00:00.000Z",
  promptVersion: "clip-selection-v1",
  provider: "local",
  model: "deterministic-eval-baseline",
  fixtureCount: 1,
  averageScore: 4.5,
  results: [
    {
      fixtureId: "sermon-001",
      sermonId: "sermon_fixture_001",
      promptVersion: "clip-selection-v1",
      provider: "local",
      model: "deterministic-eval-baseline",
      inputHash: "abc123",
      outputMetadata: {
        provider: "local",
        model: "deterministic-eval-baseline",
        promptVersion: "clip-selection-v1",
        inputHash: "abc123",
        rawOutputHash: "raw123",
        outputHash: "out123",
        createdAt: "2026-01-05T00:00:00.000Z",
        validationSucceeded: true
      },
      validationFailures: [],
      clips: [],
      scores: [],
      averageScore: 4.5
    }
  ]
};

const comparisonReport: PromptComparisonReport = {
  comparisonId: "comparison_test",
  createdAt: "2026-01-05T00:00:00.000Z",
  provider: "local",
  model: "deterministic-eval-baseline",
  fixtureCount: 1,
  bestPromptVersion: "clip-selection-v2",
  entries: [
    {
      promptVersion: "clip-selection-v1",
      runId: "eval_v1",
      averageScore: 4.2,
      validationFailureCount: 0
    },
    {
      promptVersion: "clip-selection-v2",
      runId: "eval_v2",
      averageScore: 4.6,
      validationFailureCount: 0
    }
  ],
  reports: [report]
};
