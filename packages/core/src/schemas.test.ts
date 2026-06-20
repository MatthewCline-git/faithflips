import { describe, expect, it } from "vitest";
import {
  clipCandidateSchema,
  submissionAcceptedSchema,
  submitSermonSchema,
  transcriptSegmentSchema
} from "./schemas.js";

describe("submitSermonSchema", () => {
  it("accepts YouTube watch URLs", () => {
    expect(
      submitSermonSchema.parse({ sourceUrl: "https://www.youtube.com/watch?v=abc123" })
    ).toEqual({
      sourceUrl: "https://www.youtube.com/watch?v=abc123",
      clipCount: 6
    });
  });

  it("rejects non-YouTube URLs", () => {
    expect(() => submitSermonSchema.parse({ sourceUrl: "https://example.com/sermon" })).toThrow();
  });
});

describe("submissionAcceptedSchema", () => {
  it("requires stable route fields for accepted submissions", () => {
    expect(
      submissionAcceptedSchema.parse({
        sermonId: "sermon_abc123_run_1",
        jobId: "job_abc123_run_1",
        status: "queued",
        youtubeContentId: "abc123",
        runNumber: 1,
        clipCount: 6
      })
    ).toEqual({
      sermonId: "sermon_abc123_run_1",
      jobId: "job_abc123_run_1",
      status: "queued",
      youtubeContentId: "abc123",
      runNumber: 1,
      clipCount: 6
    });
  });

  it("rejects legacy accepted responses without run route fields", () => {
    expect(() =>
      submissionAcceptedSchema.parse({
        sermonId: "sermon_abc123",
        jobId: "job_abc123",
        status: "queued"
      })
    ).toThrow();
  });
});

describe("timestamp validation", () => {
  it("rejects transcript segments that end before they start", () => {
    expect(() =>
      transcriptSegmentSchema.parse({ startSeconds: 10, endSeconds: 9, text: "Hello" })
    ).toThrow();
  });

  it("rejects clip candidates that end before they start", () => {
    expect(() =>
      clipCandidateSchema.parse({
        id: "clip_1",
        sermonId: "sermon_1",
        category: "quote",
        startSeconds: 42,
        endSeconds: 41,
        title: "Quote",
        hook: "A strong hook",
        rationale: "Good short-form fit",
        postCaption: "A caption",
        confidence: 0.9,
        promptVersion: "v1",
        model: "fake"
      })
    ).toThrow();
  });
});

