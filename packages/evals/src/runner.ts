import {
  createDeterministicClipSelectionProvider,
  modelOutputMetadataSchema,
  type ClipSelectionModelProvider
} from "@faithflips/model";
import { clipCandidateSchema } from "@faithflips/core";
import { clipSelectionPromptV1, type ClipSelectionPrompt } from "@faithflips/prompts";
import { z } from "zod";
import type { EvalFixture } from "./fixture.js";
import { scoreClipCandidate } from "./rubric.js";

export const evalFixtureResultSchema = z.object({
  fixtureId: z.string().min(1),
  sermonId: z.string().min(1),
  promptVersion: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  inputHash: z.string().min(1),
  outputMetadata: modelOutputMetadataSchema.nullable(),
  validationFailures: z.array(z.string()),
  clips: z.array(clipCandidateSchema),
  scores: z.array(
    z.object({
      clipId: z.string().min(1),
      averageScore: z.number().min(0).max(5),
      scores: z.array(
        z.object({
          dimension: z.enum([
            "standalone_quality",
            "hook_strength",
            "faithfulness",
            "spiritual_substance",
            "emotional_impact",
            "caption_quality",
            "caption_specificity",
            "direct_address",
            "conviction_and_hope",
            "platform_fit",
            "context_safety"
          ]),
          score: z.number().min(0).max(5),
          reason: z.string().min(1)
        })
      )
    })
  ),
  averageScore: z.number().min(0).max(5)
});

export const evalRunReportSchema = z.object({
  runId: z.string().min(1),
  createdAt: z.iso.datetime(),
  promptVersion: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  fixtureCount: z.number().int().nonnegative(),
  averageScore: z.number().min(0).max(5),
  results: z.array(evalFixtureResultSchema)
});

export const promptComparisonEntrySchema = z.object({
  promptVersion: z.string().min(1),
  runId: z.string().min(1),
  averageScore: z.number().min(0).max(5),
  validationFailureCount: z.number().int().nonnegative()
});

export const promptComparisonReportSchema = z.object({
  comparisonId: z.string().min(1),
  createdAt: z.iso.datetime(),
  provider: z.string().min(1),
  model: z.string().min(1),
  fixtureCount: z.number().int().nonnegative(),
  bestPromptVersion: z.string().min(1).nullable(),
  entries: z.array(promptComparisonEntrySchema).min(1),
  reports: z.array(evalRunReportSchema).min(1)
});

export type EvalFixtureResult = z.infer<typeof evalFixtureResultSchema>;
export type EvalRunReport = z.infer<typeof evalRunReportSchema>;
export type PromptComparisonReport = z.infer<typeof promptComparisonReportSchema>;

export async function runClipSelectionEval(input: {
  readonly fixtures: readonly EvalFixture[];
  readonly provider?: ClipSelectionModelProvider;
  readonly prompt?: ClipSelectionPrompt;
  readonly now?: Date;
}): Promise<EvalRunReport> {
  const prompt = input.prompt ?? clipSelectionPromptV1;
  const createdAt = input.now ?? new Date();
  const provider =
    input.provider ??
    createDeterministicClipSelectionProvider({
      now: () => createdAt
    });
  const results = await Promise.all(
    input.fixtures.map((fixture) => runFixtureEval({ fixture, provider, prompt }))
  );
  const averageScore =
    results.length === 0
      ? 0
      : roundScore(
          results.reduce((total, result) => total + result.averageScore, 0) / results.length
        );

  return evalRunReportSchema.parse({
    runId: `eval_${hashReportId(
      `${createdAt.toISOString()}:${prompt.version}:${provider.provider}:${provider.model}`
    )}`,
    createdAt: createdAt.toISOString(),
    promptVersion: prompt.version,
    provider: provider.provider,
    model: provider.model,
    fixtureCount: input.fixtures.length,
    averageScore,
    results
  });
}

export async function runClipSelectionPromptComparison(input: {
  readonly fixtures: readonly EvalFixture[];
  readonly prompts: readonly ClipSelectionPrompt[];
  readonly provider?: ClipSelectionModelProvider;
  readonly now?: Date;
}): Promise<PromptComparisonReport> {
  const createdAt = input.now ?? new Date();
  const provider =
    input.provider ??
    createDeterministicClipSelectionProvider({
      now: () => createdAt
    });
  const reports = await Promise.all(
    input.prompts.map((prompt) =>
      runClipSelectionEval({
        fixtures: input.fixtures,
        provider,
        prompt,
        now: createdAt
      })
    )
  );
  const entries = reports.map((report) => ({
    promptVersion: report.promptVersion,
    runId: report.runId,
    averageScore: report.averageScore,
    validationFailureCount: report.results.reduce(
      (total, result) => total + result.validationFailures.length,
      0
    )
  }));
  const best = entries.reduce<(typeof entries)[number] | undefined>((currentBest, entry) => {
    if (!currentBest || entry.averageScore > currentBest.averageScore) {
      return entry;
    }
    return currentBest;
  }, undefined);

  return promptComparisonReportSchema.parse({
    comparisonId: `comparison_${hashReportId(
      `${createdAt.toISOString()}:${provider.provider}:${provider.model}:${entries
        .map((entry) => entry.promptVersion)
        .join(",")}`
    )}`,
    createdAt: createdAt.toISOString(),
    provider: provider.provider,
    model: provider.model,
    fixtureCount: input.fixtures.length,
    bestPromptVersion: best?.promptVersion ?? null,
    entries,
    reports
  });
}

async function runFixtureEval(input: {
  readonly fixture: EvalFixture;
  readonly provider: ClipSelectionModelProvider;
  readonly prompt: ClipSelectionPrompt;
}): Promise<EvalFixtureResult> {
  const result = await input.provider.selectClips({
    sermonId: input.fixture.metadata.id,
    transcript: input.fixture.transcript,
    prompt: input.prompt,
    hints: input.fixture.labels.goodMoments
  });
  const validationFailures = result.ok
    ? []
    : result.error.type === "malformed_output"
      ? [...result.error.issues]
      : [result.error.message];
  const clips = result.ok ? result.value.output.clips : [];
  const scores = clips.map((clip) => scoreClipCandidate(input.fixture, clip));
  const averageScore =
    scores.length === 0
      ? 0
      : roundScore(scores.reduce((total, score) => total + score.averageScore, 0) / scores.length);

  return evalFixtureResultSchema.parse({
    fixtureId: input.fixture.id,
    sermonId: input.fixture.metadata.id,
    promptVersion: input.prompt.version,
    provider: input.provider.provider,
    model: input.provider.model,
    inputHash: result.ok ? result.value.metadata.inputHash : result.error.inputHash,
    outputMetadata: result.ok ? result.value.metadata : null,
    validationFailures,
    clips,
    scores,
    averageScore
  });
}

function roundScore(value: number): number {
  return Math.round(value * 100) / 100;
}

function hashReportId(text: string): string {
  let hash = 0;
  for (const character of text) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
