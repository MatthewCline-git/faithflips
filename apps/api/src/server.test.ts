import { describe, expect, it } from "vitest";
import { ok, submissionAcceptedSchema } from "@faithflips/core";
import type { SourceMediaClient, TranscriptionProvider } from "@faithflips/ingestion";
import type { ClipSelectionModelProvider } from "@faithflips/model";
import type { VideoRenderer } from "@faithflips/rendering";
import { z } from "zod";
import { createMemoryJobStore } from "./job-store.js";
import { createProcessingService } from "./processing-service.js";
import { createApiResponse } from "./server.js";

const jobRecordSchema = z.object({
  sermon: z.object({ sourceUrl: z.string(), title: z.string() }),
  job: z.object({ status: z.literal("completed") }),
  clips: z.array(z.unknown()).length(3)
});

describe("POST /sermons", () => {
  it("accepts submissions and exposes completed job output", async () => {
    const processing = createProcessingService({
      store: createMemoryJobStore(),
      dataDir: "/tmp/faithflips-test",
      publicBaseUrl: "http://127.0.0.1:4001",
      sourceMedia: createTestSourceMedia(),
      transcription: createTestTranscription(),
      clipSelection: createTestClipSelection(),
      renderer: createTestRenderer(),
      logger: () => undefined,
      now: () => new Date("2026-01-01T00:00:00.000Z")
    });
    const response = await createApiResponse({
      method: "POST",
      pathname: "/sermons",
      body: { sourceUrl: "https://www.youtube.com/watch?v=abc123" },
      processing,
      processJobsOnSubmit: false
    });
    const accepted = submissionAcceptedSchema.parse(response.body);

    expect(response.statusCode).toBe(202);
    expect(accepted).toMatchObject({
      youtubeContentId: "abc123",
      runNumber: 1,
      status: "queued"
    });
    await processing.processJob(accepted.jobId);

    const jobResponse = await createApiResponse({
      method: "GET",
      pathname: `/videos/${accepted.youtubeContentId}/runs/${String(accepted.runNumber)}`,
      processing
    });
    const body = jobRecordSchema.parse(jobResponse.body);
    expect(jobResponse.statusCode).toBe(200);
    expect(body.job.status).toBe("completed");
    expect(body.sermon.title).toBe("Sunday Message");
    expect(body.sermon.sourceUrl).toBe("https://www.youtube.com/watch?v=abc123");
  });

  it("loads the latest run for a source URL and creates explicit new runs", async () => {
    let selectionCalls = 0;
    const processing = createProcessingService({
      store: createMemoryJobStore(),
      dataDir: "/tmp/faithflips-test",
      publicBaseUrl: "http://127.0.0.1:4001",
      sourceMedia: createTestSourceMedia(),
      transcription: createTestTranscription(),
      clipSelection: createTestClipSelection(() => {
        selectionCalls += 1;
      }),
      renderer: createTestRenderer(),
      logger: () => undefined,
      now: () => new Date("2026-01-01T00:00:00.000Z")
    });
    const sourceUrl = "https://www.youtube.com/watch?v=abc123";

    const firstResponse = await createApiResponse({
      method: "POST",
      pathname: "/sermons",
      body: { sourceUrl },
      processing,
      processJobsOnSubmit: false
    });
    const firstAccepted = submissionAcceptedSchema.parse(firstResponse.body);
    await processing.processJob(firstAccepted.jobId);

    const secondResponse = await createApiResponse({
      method: "POST",
      pathname: "/sermons",
      body: { sourceUrl },
      processing
    });
    const secondAccepted = submissionAcceptedSchema.parse(secondResponse.body);

    expect(secondAccepted).toEqual({
      sermonId: firstAccepted.sermonId,
      jobId: firstAccepted.jobId,
      status: "completed",
      youtubeContentId: "abc123",
      runNumber: 1,
      clipCount: 6
    });
    expect(selectionCalls).toBe(1);

    const newRunResponse = await createApiResponse({
      method: "POST",
      pathname: "/videos/abc123/runs",
      body: { clipCount: 6 },
      processing,
      processJobsOnSubmit: false
    });
    const newRunAccepted = submissionAcceptedSchema.parse(newRunResponse.body);

    expect(newRunAccepted).toMatchObject({
      youtubeContentId: "abc123",
      runNumber: 2,
      status: "queued"
    });
    expect(newRunAccepted.jobId).not.toBe(firstAccepted.jobId);

    await processing.processJob(newRunAccepted.jobId);
    expect(selectionCalls).toBe(2);
  });

  it("rejects non-YouTube submissions", async () => {
    const response = await createApiResponse({
      method: "POST",
      pathname: "/sermons",
      body: { sourceUrl: "https://example.com/video" },
      processing: createProcessingService({
        store: createMemoryJobStore(),
        dataDir: "/tmp/faithflips-test",
        publicBaseUrl: "http://127.0.0.1:4001",
        sourceMedia: createTestSourceMedia(),
        transcription: createTestTranscription(),
        clipSelection: createTestClipSelection(),
        renderer: createTestRenderer(),
        logger: () => undefined
      })
    });

    expect(response).toMatchObject({
      statusCode: 400,
      body: { error: { code: "invalid_sermon_submission" } }
    });
  });

  it("returns not found for missing jobs", async () => {
    const response = await createApiResponse({
      method: "GET",
      pathname: "/jobs/job_missing",
      processing: createProcessingService({
        store: createMemoryJobStore(),
        dataDir: "/tmp/faithflips-test",
        publicBaseUrl: "http://127.0.0.1:4001",
        sourceMedia: createTestSourceMedia(),
        transcription: createTestTranscription(),
        clipSelection: createTestClipSelection(),
        renderer: createTestRenderer(),
        logger: () => undefined
      })
    });

    expect(response).toMatchObject({
      statusCode: 404,
      body: { error: { code: "job_not_found" } }
    });
  });

  it("allows re-rendering a clip with new timestamps", async () => {
    const processing = createProcessingService({
      store: createMemoryJobStore(),
      dataDir: "/tmp/faithflips-test",
      publicBaseUrl: "http://127.0.0.1:4001",
      sourceMedia: createTestSourceMedia(),
      transcription: createTestTranscription(),
      clipSelection: createTestClipSelection(),
      renderer: createTestRenderer(),
      logger: () => undefined,
      now: () => new Date("2026-01-01T00:00:00.000Z")
    });

    const submitResponse = await createApiResponse({
      method: "POST",
      pathname: "/sermons",
      body: { sourceUrl: "https://www.youtube.com/watch?v=abc123" },
      processing,
      processJobsOnSubmit: false
    });
    const accepted = submissionAcceptedSchema.parse(submitResponse.body);
    await processing.processJob(accepted.jobId);

    const rerenderResponse = await createApiResponse({
      method: "POST",
      pathname: `/clips/${accepted.sermonId}_test_clip_1/rerender`,
      body: { startSeconds: 5, endSeconds: 30 },
      processing
    });

    expect(rerenderResponse.statusCode).toBe(200);
    expect(rerenderResponse.body).toMatchObject({
      candidate: { startSeconds: 5, endSeconds: 30 },
      renderedClip: { renderStatus: "completed" }
    });
  });
});

function createTestSourceMedia(): SourceMediaClient {
  return {
    getMetadata(input) {
      return Promise.resolve(
        ok({
          sourceType: "youtube_url",
          sourceUrl: input.sourceUrl,
          videoId: "abc123",
          title: "Sunday Message",
          authorName: "Pastor",
          providerName: "Local Test",
          fetchedAt: "2026-01-01T00:00:00.000Z"
        })
      );
    },
    getMedia(input) {
      return Promise.resolve(
        ok({
          sourceType: "youtube_url",
          sourceUrl: input.sourceUrl,
          videoId: "abc123",
          mediaUrl: "/tmp/faithflips-test/source.mp4",
          access: "remote_reference"
        })
      );
    }
  };
}

function createTestTranscription(): TranscriptionProvider {
  return {
    provider: "test",
    model: "test-transcript",
    transcribe(input) {
      return Promise.resolve(
        ok({
          transcript: {
            sermonId: input.sermonId,
            language: "en",
            segments: [
              { startSeconds: 0, endSeconds: 18, text: "Opening context from a real transcript." },
              { startSeconds: 18, endSeconds: 52, text: "Grace meets tired people with hope." },
              { startSeconds: 52, endSeconds: 96, text: "Come respond with faith today." }
            ]
          },
          metadata: {
            provider: "test",
            model: "test-transcript",
            language: "en",
            createdAt: "2026-01-01T00:00:00.000Z"
          }
        })
      );
    }
  };
}

function createTestRenderer(): VideoRenderer {
  const base = "http://127.0.0.1:4001/assets/renders";
  return {
    render(input) {
      return Promise.resolve(
        ok({
          clipCandidateId: input.candidate.id,
          format: "mp4",
          aspectRatio: "9:16",
          cropVideoUrl: `${base}/${input.candidate.sermonId}/${input.candidate.id}-crop.mp4`,
          blurVideoUrl: `${base}/${input.candidate.sermonId}/${input.candidate.id}-blur.mp4`,
          thumbnailUrl: `${base}/${input.candidate.sermonId}/${input.candidate.id}.jpg`,
          subtitleStyle: "bold-readable",
          renderStatus: "completed",
          previewStartSeconds: 0
        })
      );
    },
    stitch(input) {
      return Promise.resolve(
        ok({
          finalVideoUrl: `${base}/${input.candidate.sermonId}/${input.candidate.id}-final.mp4`
        })
      );
    }
  };
}

function createTestClipSelection(onSelect?: () => void): ClipSelectionModelProvider {
  return {
    provider: "test",
    model: "test-selector",
    selectClips(input) {
      onSelect?.();
      return Promise.resolve(
        ok({
          output: {
            clips: input.transcript.segments.slice(0, 3).map((segment, index) => ({
              id: `${input.sermonId}_test_clip_${String(index + 1)}`,
              sermonId: input.sermonId,
              startSeconds: segment.startSeconds,
              endSeconds: segment.endSeconds,
              title: "Test clip",
              hook: "Test hook",
              rationale: "Selected from test transcript.",
              postCaption: "Test caption",
              confidence: 0.8,
              promptVersion: input.prompt.version,
              model: "test-selector",
              blurPadSpans: []
            }))
          },
          metadata: {
            provider: "test",
            model: "test-selector",
            promptVersion: input.prompt.version,
            inputHash: "test-input",
            rawOutputHash: "test-raw",
            outputHash: "test-output",
            createdAt: "2026-01-01T00:00:00.000Z",
            validationSucceeded: true
          }
        })
      );
    }
  };
}
