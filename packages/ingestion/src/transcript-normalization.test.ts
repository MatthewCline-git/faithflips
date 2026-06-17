import { describe, expect, it } from "vitest";
import { normalizeTranscriptSegments } from "./transcript-normalization.js";

describe("normalizeTranscriptSegments", () => {
  it("sorts segments and normalizes whitespace and timestamps", () => {
    const result = normalizeTranscriptSegments({
      sermonId: "sermon_1",
      language: "EN",
      segments: [
        { startSeconds: 10.1234, endSeconds: 12.9876, text: "  second   segment " },
        { startSeconds: 0, endSeconds: 5, text: " first\nsegment " }
      ]
    });

    expect(result).toEqual({
      ok: true,
      value: {
        sermonId: "sermon_1",
        language: "en",
        segments: [
          { startSeconds: 0, endSeconds: 5, text: "first segment" },
          { startSeconds: 10.123, endSeconds: 12.988, text: "second segment" }
        ]
      }
    });
  });

  it("rejects empty transcripts after text cleanup", () => {
    const result = normalizeTranscriptSegments({
      sermonId: "sermon_1",
      language: "en",
      segments: [{ startSeconds: 0, endSeconds: 5, text: "   " }]
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("invalid_transcript");
      expect(result.error.issues[0]).toContain("segments");
    }
  });

  it("rejects overlapping segments", () => {
    const result = normalizeTranscriptSegments({
      sermonId: "sermon_1",
      language: "en",
      segments: [
        { startSeconds: 0, endSeconds: 10, text: "First segment" },
        { startSeconds: 8, endSeconds: 12, text: "Overlap" }
      ]
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.issues).toContain("segments.1: Transcript segments must not overlap");
    }
  });
});
