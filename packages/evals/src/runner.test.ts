import { err } from "@faithflips/core";
import {
  clipSelectionPromptV1,
  clipSelectionPromptV2,
  clipSelectionPromptV3
} from "@faithflips/prompts";
import { describe, expect, it } from "vitest";
import { runClipSelectionEval, runClipSelectionPromptComparison } from "./runner.js";
import type { EvalFixture } from "./fixture.js";

describe("clip selection eval runner", () => {
  it("validates model output and scores clips with the rubric", async () => {
    const report = await runClipSelectionEval({
      fixtures: [fixture],
      now: new Date("2026-01-05T00:00:00.000Z")
    });

    expect(report.fixtureCount).toBe(1);
    expect(report.promptVersion).toBe("clip-selection-v1");
    expect(report.provider).toBe("local");
    expect(report.results[0]?.outputMetadata?.promptVersion).toBe("clip-selection-v1");
    expect(report.results[0]?.validationFailures).toEqual([]);
    expect(report.results[0]?.clips).toHaveLength(1);
    expect(report.results[0]?.scores[0]?.scores).toHaveLength(11);
    expect(report.averageScore).toBeGreaterThan(4);
  });

  it("records validation failures for malformed model output", async () => {
    const report = await runClipSelectionEval({
      fixtures: [fixture],
      provider: {
        provider: "test",
        model: "bad-model",
        selectClips() {
          return Promise.resolve(
            err({
              type: "malformed_output",
              provider: "test",
              model: "bad-model",
              promptVersion: "clip-selection-v1",
              inputHash: "input_hash",
              rawOutputHash: "raw_output_hash",
              issues: ["clips.0.sermonId: Required"]
            })
          );
        }
      },
      now: new Date("2026-01-05T00:00:00.000Z")
    });

    expect(report.results[0]?.validationFailures.length).toBeGreaterThan(0);
    expect(report.results[0]?.averageScore).toBe(0);
  });

  it("compares two prompt versions against the same fixtures", async () => {
    const comparison = await runClipSelectionPromptComparison({
      fixtures: [fixture],
      prompts: [clipSelectionPromptV1, clipSelectionPromptV2, clipSelectionPromptV3],
      now: new Date("2026-01-05T00:00:00.000Z")
    });

    expect(comparison.entries.map((entry) => entry.promptVersion)).toEqual([
      "clip-selection-v1",
      "clip-selection-v2",
      "clip-selection-v3"
    ]);
    expect(comparison.bestPromptVersion).toBeTruthy();
    expect(comparison.reports).toHaveLength(3);
  });
});

const fixture: EvalFixture = {
  id: "fixture-test",
  metadata: {
    id: "sermon_fixture_test",
    sourceType: "youtube_url",
    sourceUrl: "https://www.youtube.com/watch?v=fixturetest",
    title: "Fixture Test",
    speaker: "Pastor Test",
    durationSeconds: 300,
    createdAt: "2026-01-05T00:00:00.000Z",
    clipCount: 6
  },
  transcript: {
    sermonId: "sermon_fixture_test",
    language: "en",
    segments: [
      {
        startSeconds: 10,
        endSeconds: 60,
        text: "Some of us are tired, and grace meets us with mercy. Jesus invites burdened people to come honestly and receive rest."
      }
    ]
  },
  labels: {
    goodMoments: [
      {
        category: "encouragement",
        startSeconds: 10,
        endSeconds: 60,
        note: "Complete encouragement with direct pastoral comfort."
      }
    ]
  }
};
