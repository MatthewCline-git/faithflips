import { describe, expect, it } from "vitest";
import {
  transitionProcessingJob,
  type ProcessingJob,
  type ProcessingJobEvent,
  type ProcessingJobStatus
} from "./processing-job.js";

const baseJob: ProcessingJob = {
  id: "job_1",
  sermonId: "sermon_1",
  status: "queued",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z"
};

const allowedTransitions: readonly [
  ProcessingJobStatus,
  ProcessingJobEvent,
  ProcessingJobStatus
][] = [
  ["queued", "start_source_fetch", "fetching_source"],
  ["fetching_source", "source_fetched", "transcribing"],
  ["transcribing", "transcript_ready", "selecting_clips"],
  ["selecting_clips", "clips_selected", "rendering_clips"],
  ["rendering_clips", "rendering_finished", "completed"]
];

describe("transitionProcessingJob", () => {
  it.each(allowedTransitions)("moves %s through %s to %s", (status, event, nextStatus) => {
    const result = transitionProcessingJob(
      { ...baseJob, status },
      event,
      "2026-01-01T00:00:01.000Z"
    );

    expect(result).toEqual({
      ok: true,
      value: {
        ...baseJob,
        status: nextStatus,
        updatedAt: "2026-01-01T00:00:01.000Z"
      }
    });
  });

  it("allows active jobs to fail with a typed failure reason", () => {
    const result = transitionProcessingJob(
      { ...baseJob, status: "transcribing" },
      "fail",
      "2026-01-01T00:00:01.000Z",
      "transcript unavailable"
    );

    expect(result).toEqual({
      ok: true,
      value: {
        ...baseJob,
        status: "failed",
        updatedAt: "2026-01-01T00:00:01.000Z",
        failureReason: "transcript unavailable"
      }
    });
  });

  it("rejects transitions that skip lifecycle steps", () => {
    const result = transitionProcessingJob(
      { ...baseJob, status: "queued" },
      "transcript_ready",
      "2026-01-01T00:00:01.000Z"
    );

    expect(result).toEqual({
      ok: false,
      error: {
        code: "invalid_job_transition",
        currentStatus: "queued",
        event: "transcript_ready"
      }
    });
  });
});
