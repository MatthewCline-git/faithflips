import { err, ok, type Result } from "@faithflips/core";
import { describe, expect, it } from "vitest";
import { createTranscriptIngestionWorkflow, type TranscriptIngestionError } from "./workflow.js";
import type { SourceMediaClient, SourceMediaError } from "./source-media.js";
import type { TranscriptionProvider } from "./transcription.js";

const metadata = {
  sourceType: "youtube_url",
  sourceUrl: "https://www.youtube.com/watch?v=abc123",
  videoId: "abc123",
  title: "Sunday Sermon",
  authorName: "Grace Church",
  providerName: "YouTube",
  fetchedAt: "2026-01-01T00:00:00.000Z"
} as const;

const media = {
  sourceType: "youtube_url",
  sourceUrl: "https://www.youtube.com/watch?v=abc123",
  videoId: "abc123",
  mediaUrl: "https://www.youtube.com/watch?v=abc123",
  access: "remote_reference"
} as const;

const transcriptResponse = {
  transcript: {
    sermonId: "sermon_1",
    language: "en",
    segments: [{ startSeconds: 0, endSeconds: 5, text: "Hello church" }]
  },
  metadata: {
    provider: "local",
    model: "deterministic-transcriber",
    language: "en",
    createdAt: "2026-01-01T00:00:01.000Z"
  }
};

describe("createTranscriptIngestionWorkflow", () => {
  it("fetches source media, transcribes it, and logs workflow boundaries", async () => {
    const events: Record<string, unknown>[] = [];
    const workflow = createTranscriptIngestionWorkflow({
      sourceMedia: sourceMediaClient(),
      transcription: transcriptionProvider(),
      logger: (event) => events.push(event)
    });

    const result = await workflow.ingestTranscript({
      sermonId: "sermon_1",
      sourceUrl: "https://www.youtube.com/watch?v=abc123"
    });

    expect(result).toEqual({
      ok: true,
      value: {
        metadata,
        media,
        transcript: transcriptResponse.transcript,
        transcription: transcriptResponse.metadata
      }
    });
    expect(events.map((event) => event["event"])).toEqual([
      "source_fetch_started",
      "source_fetch_completed",
      "transcription_started",
      "transcription_completed"
    ]);
  });

  it("returns typed source media failures", async () => {
    const sourceError: SourceMediaError = {
      type: "source_unavailable",
      sourceUrl: "https://www.youtube.com/watch?v=abc123",
      provider: "youtube",
      message: "Not found",
      status: 404
    };
    const workflow = createTranscriptIngestionWorkflow({
      sourceMedia: sourceMediaClient(err(sourceError)),
      transcription: transcriptionProvider()
    });

    const result = await workflow.ingestTranscript({
      sermonId: "sermon_1",
      sourceUrl: "https://www.youtube.com/watch?v=abc123"
    });

    expect(result).toEqual({
      ok: false,
      error: { type: "source_media_failed", step: "metadata", error: sourceError }
    } satisfies Result<unknown, TranscriptIngestionError>);
  });

  it("returns typed transcription failures", async () => {
    const workflow = createTranscriptIngestionWorkflow({
      sourceMedia: sourceMediaClient(),
      transcription: transcriptionProvider(
        err({
          type: "transcript_unavailable",
          provider: "local",
          model: "deterministic-transcriber",
          sermonId: "sermon_1",
          message: "No transcript"
        })
      )
    });

    const result = await workflow.ingestTranscript({
      sermonId: "sermon_1",
      sourceUrl: "https://www.youtube.com/watch?v=abc123"
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("transcription_failed");
    }
  });
});

function sourceMediaClient(
  metadataResult: Awaited<ReturnType<SourceMediaClient["getMetadata"]>> = ok(metadata)
): SourceMediaClient {
  return {
    getMetadata: () => Promise.resolve(metadataResult),
    getMedia: () => Promise.resolve(ok(media))
  };
}

function transcriptionProvider(
  result: Awaited<ReturnType<TranscriptionProvider["transcribe"]>> = ok(transcriptResponse)
): TranscriptionProvider {
  return {
    provider: "local",
    model: "deterministic-transcriber",
    transcribe: () => Promise.resolve(result)
  };
}
