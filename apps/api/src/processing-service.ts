import {
  clipCandidateSchema,
  err,
  ok,
  sermonSchema,
  transitionProcessingJob,
  type GeneratedClip,
  type ProcessingJob,
  type ProcessingJobEvent,
  type Result,
  type Sermon,
  type SubmissionAccepted,
  type SubmitSermonInput,
  type Transcript
} from "@faithflips/core";
import {
  createTranscriptIngestionWorkflow,
  parseYouTubeVideoId,
  type SourceMediaClient,
  type SourceMediaMetadata,
  type TranscriptionProvider
} from "@faithflips/ingestion";
import type { ClipSelectionModelProvider } from "@faithflips/model";
import { clipSelectionPromptV3 } from "@faithflips/prompts";
import { createFfmpegRenderer, type VideoRenderer } from "@faithflips/rendering";
import { z } from "zod";
import type { JobStore, PersistedJobRecord } from "./job-store.js";
import {
  createLocalDevSourceMediaClient,
  createLocalRenderWorkspace,
  createLocalStorageClient,
  createNodeCommandRunner,
  createYtDlpTranscriptionProvider
} from "./local-dev-runtime.js";
import { createOpenAiClipSelectionProvider } from "./openai-clip-selector.js";

export type ProcessingServiceError =
  | {
      readonly type: "invalid_source_url";
      readonly message: string;
    }
  | {
      readonly type: "job_not_found";
      readonly jobId: string;
    }
  | {
      readonly type: "workflow_failed";
      readonly jobId: string;
      readonly message: string;
    };

export type ProcessingService = {
  submit(input: SubmitSermonInput): Promise<Result<SubmissionAccepted, ProcessingServiceError>>;
  createRun(input: {
    readonly youtubeContentId: string;
    readonly clipCount: number;
  }): Promise<Result<SubmissionAccepted, ProcessingServiceError>>;
  getRun(
    youtubeContentId: string,
    runNumber: number
  ): Promise<Result<PersistedJobRecord, ProcessingServiceError>>;
  getLatestRun(
    youtubeContentId: string
  ): Promise<Result<PersistedJobRecord, ProcessingServiceError>>;
  processJob(jobId: string): Promise<Result<PersistedJobRecord, ProcessingServiceError>>;
  getJob(jobId: string): Promise<Result<PersistedJobRecord, ProcessingServiceError>>;
  rerenderClip(
    clipId: string,
    trim: { startSeconds: number; endSeconds: number }
  ): Promise<Result<GeneratedClip, ProcessingServiceError>>;
};

export function createProcessingService(input: {
  readonly store: JobStore;
  readonly dataDir: string;
  readonly now?: () => Date;
  readonly sourceMedia?: SourceMediaClient;
  readonly transcription?: TranscriptionProvider;
  readonly clipSelection?: ClipSelectionModelProvider;
  readonly renderer?: VideoRenderer;
  readonly logger?: (event: Record<string, unknown>) => void;
}): ProcessingService {
  const now = input.now ?? (() => new Date());
  const logger =
    input.logger ??
    ((event) => {
      console.log(JSON.stringify(event));
    });
  const commandRunner = createNodeCommandRunner();
  const sourceMedia =
    input.sourceMedia ??
    createLocalDevSourceMediaClient({
      dataDir: input.dataDir,
      now,
      logger
    });
  const transcription =
    input.transcription ??
    createYtDlpTranscriptionProvider({
      dataDir: input.dataDir,
      now,
      logger
    });
  const model =
    input.clipSelection ??
    createOpenAiClipSelectionProvider({
      now,
      logger,
      ...(process.env["OPENAI_API_KEY"] ? { apiKey: process.env["OPENAI_API_KEY"] } : {})
    });
  const renderer =
    input.renderer ??
    createFfmpegRenderer({
      commandRunner,
      storage: createLocalStorageClient({
        assetRoot: `${input.dataDir}/public`
      }),
      workspace: createLocalRenderWorkspace({ workDir: `${input.dataDir}/work` }),
      logger
    });
  const ingestion = createTranscriptIngestionWorkflow({
    sourceMedia,
    transcription,
    logger
  });

  return {
    async submit(submission) {
      const videoIdResult = parseYouTubeVideoId(submission.sourceUrl);
      if (!videoIdResult.ok) {
        return err({
          type: "invalid_source_url",
          message: sourceMediaErrorMessage(videoIdResult.error)
        });
      }

      const latest = await latestRun(input.store, videoIdResult.value);
      if (latest) {
        return ok(toAccepted(latest.record, videoIdResult.value, latest.runNumber));
      }

      return createQueuedRun({
        store: input.store,
        logger,
        now,
        youtubeContentId: videoIdResult.value,
        runNumber: 1,
        clipCount: submission.clipCount
      });
    },
    async createRun(runInput) {
      const parsed = youtubeContentIdSchema.safeParse(runInput.youtubeContentId);
      if (!parsed.success) {
        return err({
          type: "invalid_source_url",
          message: "Invalid YouTube content id"
        });
      }
      const latest = await latestRun(input.store, parsed.data);
      return createQueuedRun({
        store: input.store,
        logger,
        now,
        youtubeContentId: parsed.data,
        runNumber: (latest?.runNumber ?? 0) + 1,
        clipCount: runInput.clipCount
      });
    },
    async getRun(youtubeContentId, runNumber) {
      const record = await input.store.get(jobIdForRun(youtubeContentId, runNumber));
      return record
        ? ok(record)
        : err({ type: "job_not_found", jobId: jobIdForRun(youtubeContentId, runNumber) });
    },
    async getLatestRun(youtubeContentId) {
      const latest = await latestRun(input.store, youtubeContentId);
      return latest
        ? ok(latest.record)
        : err({ type: "job_not_found", jobId: `video_${youtubeContentId}` });
    },
    async processJob(jobId) {
      const record = await input.store.get(jobId);
      if (!record) {
        return err({ type: "job_not_found", jobId });
      }

      const sourceStarted = await applyTransition(input.store, record, "start_source_fetch", now);
      if (!sourceStarted.ok) {
        return sourceStarted;
      }

      const ingestionResult = await ingestion.ingestTranscript({
        sermonId: sourceStarted.value.sermon.id,
        sourceUrl: sourceStarted.value.sermon.sourceUrl
      });
      if (!ingestionResult.ok) {
        return failJob(
          input.store,
          sourceStarted.value,
          `Transcript ingestion failed: ${transcriptIngestionErrorMessage(ingestionResult.error)}`,
          now,
          logger
        );
      }

      const metadata = ingestionResult.value.metadata;
      const sourceFetched = await applyTransition(
        input.store,
        withSermonMetadata(sourceStarted.value, metadata, ingestionResult.value.transcript),
        "source_fetched",
        now
      );
      if (!sourceFetched.ok) {
        return sourceFetched;
      }

      const transcriptReady = await applyTransition(
        input.store,
        sourceFetched.value,
        "transcript_ready",
        now
      );
      if (!transcriptReady.ok) {
        return transcriptReady;
      }

      logger({
        event: "clip_selection_started",
        sermonId: transcriptReady.value.sermon.id,
        jobId: transcriptReady.value.job.id,
        model: model.model,
        promptVersion: clipSelectionPromptV3.version
      });
      const clipSelection = await model.selectClips({
        sermonId: transcriptReady.value.sermon.id,
        transcript: ingestionResult.value.transcript,
        prompt: clipSelectionPromptV3,
        clipCount: transcriptReady.value.sermon.clipCount
      });
      if (!clipSelection.ok) {
        logger({
          event: "clip_selection_failed",
          sermonId: transcriptReady.value.sermon.id,
          jobId: transcriptReady.value.job.id,
          error: modelProviderErrorMessage(clipSelection.error)
        });
        return failJob(
          input.store,
          transcriptReady.value,
          `Clip selection failed: ${modelProviderErrorMessage(clipSelection.error)}`,
          now,
          logger
        );
      }

      logger({
        event: "clip_selection_completed",
        sermonId: transcriptReady.value.sermon.id,
        jobId: transcriptReady.value.job.id,
        clipCount: clipSelection.value.output.clips.length
      });

      const clipsSelected = await applyTransition(
        input.store,
        transcriptReady.value,
        "clips_selected",
        now
      );
      if (!clipsSelected.ok) {
        return clipsSelected;
      }

      const clipTotal = clipSelection.value.output.clips.length;
      logger({
        event: "rendering_started",
        sermonId: clipsSelected.value.sermon.id,
        jobId: clipsSelected.value.job.id,
        clipCount: clipTotal
      });

      const renderedClips: GeneratedClip[] = [];
      for (let i = 0; i < clipSelection.value.output.clips.length; i++) {
        const parsedCandidate = clipCandidateSchema.parse(clipSelection.value.output.clips[i]);
        const clipIndex = i + 1;
        logger({
          event: "clip_render_started",
          sermonId: clipsSelected.value.sermon.id,
          jobId: clipsSelected.value.job.id,
          clipIndex,
          clipTotal,
          clipTitle: parsedCandidate.title,
          startSeconds: parsedCandidate.startSeconds,
          endSeconds: parsedCandidate.endSeconds
        });
        const rendered = await renderer.render({
          candidate: parsedCandidate,
          transcript: ingestionResult.value.transcript,
          sourceMedia: ingestionResult.value.media
        });
        if (!rendered.ok) {
          const renderError = rendered.error;
          const renderMessage =
            "message" in renderError ? renderError.message : renderError.type;
          logger({
            event: "clip_render_failed",
            sermonId: clipsSelected.value.sermon.id,
            jobId: clipsSelected.value.job.id,
            clipIndex,
            error: renderMessage
          });
          return failJob(
            input.store,
            clipsSelected.value,
            `Rendering failed: ${renderMessage}`,
            now,
            logger
          );
        }
        logger({
          event: "clip_render_completed",
          sermonId: clipsSelected.value.sermon.id,
          jobId: clipsSelected.value.job.id,
          clipIndex,
          clipTotal,
          cropVideoUrl: rendered.value.cropVideoUrl
        });
        renderedClips.push({ candidate: parsedCandidate, renderedClip: rendered.value });
      }

      logger({
        event: "rendering_completed",
        sermonId: clipsSelected.value.sermon.id,
        jobId: clipsSelected.value.job.id,
        clipCount: renderedClips.length
      });

      const completed = await applyTransition(
        input.store,
        { ...clipsSelected.value, clips: renderedClips },
        "rendering_finished",
        now
      );
      if (!completed.ok) {
        return completed;
      }

      logger({
        event: "workflow_completed",
        sermonId: completed.value.sermon.id,
        jobId: completed.value.job.id,
        clipCount: completed.value.clips.length
      });
      return completed;
    },
    async getJob(jobId) {
      const record = await input.store.get(jobId);
      return record ? ok(record) : err({ type: "job_not_found", jobId });
    },
    async rerenderClip(clipId, trim) {
      const found = await findClip(input.store, clipId);
      if (!found) {
        return err({ type: "job_not_found", jobId: clipId });
      }
      const { record, clipIndex, clip } = found;

      const updatedCandidate = clipCandidateSchema.parse({
        ...clip.candidate,
        startSeconds: trim.startSeconds,
        endSeconds: trim.endSeconds
      });

      logger({
        event: "clip_rerender_started",
        clipId,
        sermonId: record.sermon.id,
        startSeconds: trim.startSeconds,
        endSeconds: trim.endSeconds
      });

      const mediaResult = await sourceMedia.getMedia({
        sourceUrl: record.sermon.sourceUrl
      });
      if (!mediaResult.ok) {
        return err({
          type: "workflow_failed",
          jobId: record.job.id,
          message: `Failed to get media: ${mediaResult.error.type}`
        });
      }

      let rerenderTranscript: Transcript;
      if (record.transcript) {
        rerenderTranscript = record.transcript;
      } else {
        const transcriptResult = await transcription.transcribe({
          sermonId: record.sermon.id,
          media: mediaResult.value
        });
        if (!transcriptResult.ok) {
          return err({
            type: "workflow_failed",
            jobId: record.job.id,
            message: `Failed to get transcript: ${transcriptResult.error.type}`
          });
        }
        rerenderTranscript = transcriptResult.value.transcript;
      }

      const rendered = await renderer.render({
        candidate: updatedCandidate,
        transcript: rerenderTranscript,
        sourceMedia: mediaResult.value
      });

      if (!rendered.ok) {
        logger({
          event: "clip_rerender_failed",
          clipId,
          error: rendered.error.type
        });
        return err({
          type: "workflow_failed",
          jobId: record.job.id,
          message: `Render failed: ${rendered.error.type}`
        });
      }

      const updatedClip: GeneratedClip = {
        candidate: updatedCandidate,
        renderedClip: rendered.value
      };

      const updatedClips = [...record.clips];
      updatedClips[clipIndex] = updatedClip;
      await input.store.update({ ...record, clips: updatedClips });

      logger({
        event: "clip_rerender_completed",
        clipId,
        cropVideoUrl: rendered.value.cropVideoUrl
      });

      return ok(updatedClip);
    }
  };
}

async function findClip(
  store: JobStore,
  clipId: string
): Promise<{ record: PersistedJobRecord; clipIndex: number; clip: GeneratedClip } | undefined> {
  const allJobs = await store.list();
  for (const record of allJobs) {
    const clipIndex = record.clips.findIndex((c) => c.candidate.id === clipId);
    const clip = record.clips[clipIndex];
    if (clipIndex >= 0 && clip) {
      return { record, clipIndex, clip };
    }
  }
  return undefined;
}

async function applyTransition(
  store: JobStore,
  record: PersistedJobRecord,
  event: ProcessingJobEvent,
  now: () => Date
): Promise<Result<PersistedJobRecord, ProcessingServiceError>> {
  const transition = transitionProcessingJob(
    toProcessingJob(record.job),
    event,
    now().toISOString()
  );
  if (!transition.ok) {
    return err({
      type: "workflow_failed",
      jobId: record.job.id,
      message: `Invalid transition from ${transition.error.currentStatus} using ${transition.error.event}`
    });
  }

  const updatedRecord = { ...record, job: transition.value };
  await store.update(updatedRecord);
  return ok(updatedRecord);
}

async function failJob(
  store: JobStore,
  record: PersistedJobRecord,
  message: string,
  now: () => Date,
  logger?: (event: Record<string, unknown>) => void
): Promise<Result<PersistedJobRecord, ProcessingServiceError>> {
  const failed = transitionProcessingJob(
    toProcessingJob(record.job),
    "fail",
    now().toISOString(),
    message
  );
  if (!failed.ok) {
    return err({ type: "workflow_failed", jobId: record.job.id, message });
  }

  const failedRecord = { ...record, job: failed.value };
  await store.update(failedRecord);

  logger?.({
    event: "workflow_failed",
    sermonId: record.sermon.id,
    jobId: record.job.id,
    message
  });

  return err({ type: "workflow_failed", jobId: record.job.id, message });
}

function withSermonMetadata(
  record: PersistedJobRecord,
  metadata: SourceMediaMetadata,
  transcript: Transcript
): PersistedJobRecord {
  const durationSeconds = Math.max(1, ...transcript.segments.map((segment) => segment.endSeconds));
  const sermon: Sermon = sermonSchema.parse({
    ...record.sermon,
    title: metadata.title,
    speaker: metadata.authorName,
    durationSeconds
  });
  return { ...record, sermon, transcript };
}

function toProcessingJob(job: PersistedJobRecord["job"]): ProcessingJob {
  return job.failureReason === undefined
    ? {
        id: job.id,
        sermonId: job.sermonId,
        status: job.status,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt
      }
    : {
        id: job.id,
        sermonId: job.sermonId,
        status: job.status,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        failureReason: job.failureReason
      };
}

function sourceMediaErrorMessage(error: {
  readonly type: string;
  readonly message?: string;
}): string {
  return error.message ?? error.type;
}

function transcriptIngestionErrorMessage(error: {
  readonly type: string;
  readonly error?: { readonly type: string; readonly message?: string };
}): string {
  return error.error ? sourceMediaErrorMessage(error.error) : error.type;
}

function modelProviderErrorMessage(error: {
  readonly type: string;
  readonly message?: string;
  readonly issues?: readonly string[];
}): string {
  if (error.message) {
    return error.message;
  }
  if (error.issues && error.issues.length > 0) {
    return error.issues.join("; ");
  }
  return error.type;
}

const youtubeContentIdSchema = z.string().regex(/^[A-Za-z0-9_-]{6,}$/);

function canonicalYouTubeUrl(youtubeContentId: string): string {
  return `https://www.youtube.com/watch?v=${youtubeContentId}`;
}

function sermonIdForRun(youtubeContentId: string, runNumber: number): string {
  return `sermon_${youtubeContentId}_run_${String(runNumber)}`;
}

function jobIdForRun(youtubeContentId: string, runNumber: number): string {
  return `job_${youtubeContentId}_run_${String(runNumber)}`;
}

function runNumberFromJobId(jobId: string, youtubeContentId: string): number | undefined {
  const prefix = `job_${youtubeContentId}_run_`;
  if (!jobId.startsWith(prefix)) return undefined;
  const runNumber = Number(jobId.slice(prefix.length));
  return Number.isInteger(runNumber) && runNumber > 0 ? runNumber : undefined;
}

async function latestRun(
  store: JobStore,
  youtubeContentId: string
): Promise<{ readonly record: PersistedJobRecord; readonly runNumber: number } | undefined> {
  const records = await store.list();
  return records.reduce<
    { readonly record: PersistedJobRecord; readonly runNumber: number } | undefined
  >((latest, record) => {
    const runNumber = runNumberFromJobId(record.job.id, youtubeContentId);
    if (runNumber === undefined) return latest;
    return latest === undefined || runNumber > latest.runNumber ? { record, runNumber } : latest;
  }, undefined);
}

function toAccepted(
  record: PersistedJobRecord,
  youtubeContentId: string,
  runNumber: number
): SubmissionAccepted {
  return {
    sermonId: record.sermon.id,
    jobId: record.job.id,
    status: record.job.status,
    youtubeContentId,
    runNumber,
    clipCount: record.sermon.clipCount
  };
}

async function createQueuedRun(input: {
  readonly store: JobStore;
  readonly logger: (event: Record<string, unknown>) => void;
  readonly now: () => Date;
  readonly youtubeContentId: string;
  readonly runNumber: number;
  readonly clipCount: number;
}): Promise<Result<SubmissionAccepted, ProcessingServiceError>> {
  const createdAt = input.now().toISOString();
  const sermon = sermonSchema.parse({
    id: sermonIdForRun(input.youtubeContentId, input.runNumber),
    sourceType: "youtube_url",
    sourceUrl: canonicalYouTubeUrl(input.youtubeContentId),
    title: "Processing sermon",
    speaker: "Unknown speaker",
    durationSeconds: 1,
    createdAt,
    clipCount: input.clipCount
  });
  const job: ProcessingJob = {
    id: jobIdForRun(input.youtubeContentId, input.runNumber),
    sermonId: sermon.id,
    status: "queued",
    createdAt,
    updatedAt: createdAt
  };

  await input.store.create({ sermon, job, clips: [] });
  input.logger({
    event: "sermon_submitted",
    sermonId: sermon.id,
    jobId: job.id,
    sourceType: sermon.sourceType,
    sourceUrl: sermon.sourceUrl,
    youtubeContentId: input.youtubeContentId,
    runNumber: input.runNumber
  });

  return ok(toAccepted({ sermon, job, clips: [] }, input.youtubeContentId, input.runNumber));
}
