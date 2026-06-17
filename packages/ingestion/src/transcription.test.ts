import { describe, expect, it } from "vitest";
import { createDeterministicTranscriptionProvider } from "./transcription.js";

const media = {
  sourceType: "youtube_url",
  sourceUrl: "https://www.youtube.com/watch?v=abc123",
  videoId: "abc123",
  mediaUrl: "https://www.youtube.com/watch?v=abc123",
  access: "remote_reference"
} as const;

describe("createDeterministicTranscriptionProvider", () => {
  it("returns normalized transcripts with provider metadata", async () => {
    const provider = createDeterministicTranscriptionProvider({
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      segments: [{ startSeconds: 0, endSeconds: 5, text: " Hello   church " }]
    });

    const result = await provider.transcribe({ sermonId: "sermon_1", media });

    expect(result).toEqual({
      ok: true,
      value: {
        transcript: {
          sermonId: "sermon_1",
          language: "en",
          segments: [{ startSeconds: 0, endSeconds: 5, text: "Hello church" }]
        },
        metadata: {
          provider: "local",
          model: "deterministic-transcriber",
          language: "en",
          createdAt: "2026-01-01T00:00:00.000Z"
        }
      }
    });
  });

  it("returns malformed transcript errors for invalid provider output", async () => {
    const provider = createDeterministicTranscriptionProvider({
      segments: [{ startSeconds: 10, endSeconds: 5, text: "Bad timestamp" }]
    });

    const result = await provider.transcribe({ sermonId: "sermon_1", media });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("malformed_transcript");
      expect(result.error.sermonId).toBe("sermon_1");
    }
  });
});
