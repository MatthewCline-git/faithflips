import { describe, expect, it } from "vitest";
import { clipCandidateSchema, submitSermonSchema, transcriptSegmentSchema } from "./schemas.js";

describe("submitSermonSchema", () => {
  it("accepts YouTube watch URLs", () => {
    expect(
      submitSermonSchema.parse({ sourceUrl: "https://www.youtube.com/watch?v=abc123" })
    ).toEqual({
      sourceUrl: "https://www.youtube.com/watch?v=abc123"
    });
  });

  it("rejects non-YouTube URLs", () => {
    expect(() => submitSermonSchema.parse({ sourceUrl: "https://example.com/sermon" })).toThrow();
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

describe("clip candidate blur-pad spans", () => {
  const baseClip = {
    id: "clip_1",
    sermonId: "sermon_1",
    startSeconds: 10,
    endSeconds: 40,
    title: "Quote",
    hook: "A strong hook",
    rationale: "Good short-form fit",
    postCaption: "A caption",
    confidence: 0.9,
    promptVersion: "v1",
    model: "fake"
  };

  it("defaults blurPadSpans to an empty list", () => {
    expect(clipCandidateSchema.parse(baseClip).blurPadSpans).toEqual([]);
  });

  it("accepts sorted, non-overlapping spans", () => {
    const clip = clipCandidateSchema.parse({
      ...baseClip,
      blurPadSpans: [
        { startSeconds: 0, endSeconds: 5 },
        { startSeconds: 8, endSeconds: 12 }
      ]
    });
    expect(clip.blurPadSpans).toHaveLength(2);
  });

  it("rejects overlapping spans", () => {
    expect(() =>
      clipCandidateSchema.parse({
        ...baseClip,
        blurPadSpans: [
          { startSeconds: 0, endSeconds: 6 },
          { startSeconds: 5, endSeconds: 12 }
        ]
      })
    ).toThrow();
  });

  it("rejects a span that ends before it starts", () => {
    expect(() =>
      clipCandidateSchema.parse({
        ...baseClip,
        blurPadSpans: [{ startSeconds: 8, endSeconds: 4 }]
      })
    ).toThrow();
  });
});
