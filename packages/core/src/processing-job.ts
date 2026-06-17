import { z } from "zod";
import { err, ok, type Result } from "./result.js";

export const processingJobStatusSchema = z.enum([
  "queued",
  "fetching_source",
  "transcribing",
  "selecting_clips",
  "rendering_clips",
  "completed",
  "failed"
]);

export type ProcessingJobStatus = z.infer<typeof processingJobStatusSchema>;

export type ProcessingJob = {
  readonly id: string;
  readonly sermonId: string;
  readonly status: ProcessingJobStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly failureReason?: string;
};

export type ProcessingJobEvent =
  | "start_source_fetch"
  | "source_fetched"
  | "transcript_ready"
  | "clips_selected"
  | "rendering_finished"
  | "fail";

export type ProcessingJobTransitionError = {
  readonly code: "invalid_job_transition";
  readonly currentStatus: ProcessingJobStatus;
  readonly event: ProcessingJobEvent;
};

type Transition = {
  readonly current: ProcessingJobStatus;
  readonly event: ProcessingJobEvent;
  readonly next: ProcessingJobStatus;
};

export const processingJobTransitionMatrix = [
  { current: "queued", event: "start_source_fetch", next: "fetching_source" },
  { current: "fetching_source", event: "source_fetched", next: "transcribing" },
  { current: "transcribing", event: "transcript_ready", next: "selecting_clips" },
  { current: "selecting_clips", event: "clips_selected", next: "rendering_clips" },
  { current: "rendering_clips", event: "rendering_finished", next: "completed" }
] as const satisfies readonly Transition[];

export function transitionProcessingJob(
  job: ProcessingJob,
  event: ProcessingJobEvent,
  now: string,
  failureReason?: string
): Result<ProcessingJob, ProcessingJobTransitionError> {
  if (event === "fail" && job.status !== "completed" && job.status !== "failed") {
    const failedJob: ProcessingJob =
      failureReason === undefined
        ? { ...job, status: "failed", updatedAt: now }
        : { ...job, status: "failed", updatedAt: now, failureReason };
    return ok(failedJob);
  }

  const transition = processingJobTransitionMatrix.find(
    (item) => item.current === job.status && item.event === event
  );

  if (!transition) {
    return err({
      code: "invalid_job_transition",
      currentStatus: job.status,
      event
    });
  }

  return ok({ ...job, status: transition.next, updatedAt: now });
}
