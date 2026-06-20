import {
  clipCandidateSchema,
  generatedClipSchema,
  sermonSchema,
  type GeneratedClip,
  type Sermon
} from "./schemas.js";
import {
  transitionProcessingJob,
  type ProcessingJob,
  type ProcessingJobStatus
} from "./processing-job.js";

export type FakeWorkflowOutput = {
  readonly sermon: Sermon;
  readonly job: ProcessingJob;
  readonly clips: readonly GeneratedClip[];
};

export function createFakeWorkflowOutput(
  sourceUrl: string,
  now = new Date("2026-01-01T00:00:00.000Z")
): FakeWorkflowOutput {
  const hash = stableHash(sourceUrl);
  const sermonId = `sermon_${hash}`;
  const jobId = `job_${hash}`;
  const createdAt = now.toISOString();
  const sermon = sermonSchema.parse({
    id: sermonId,
    sourceType: "youtube_url",
    sourceUrl,
    title: "Sunday Message",
    speaker: "Pastor",
    durationSeconds: 2140,
    createdAt
  });

  const job = runFakeJob({
    id: jobId,
    sermonId,
    status: "queued",
    createdAt,
    updatedAt: createdAt
  });

  const clips = [
    buildClip({
      id: `clip_${hash}_invitation`,
      sermonId,
      category: "invitation",
      startSeconds: 182,
      endSeconds: 228,
      title: "when grace interrupts",
      hook: "If you've been waiting for a sign to make a change, this is it.",
      rationale: "The moment stands alone and invites viewers into a concrete next step.",
      postCaption: "Grace isn't something you admire. It's something you respond to."
    }),
    buildClip({
      id: `clip_${hash}_encouragement`,
      sermonId,
      category: "encouragement",
      startSeconds: 746,
      endSeconds: 794,
      title: "for the tired ones",
      hook: "If this week has worn you down, you need to hear this.",
      rationale: "The clip offers a complete encouragement with a strong opening line.",
      postCaption: "God meets you with strength for today. Not tomorrow. Today."
    }),
    buildClip({
      id: `clip_${hash}_teaching`,
      sermonId,
      category: "teaching",
      startSeconds: 1294,
      endSeconds: 1358,
      title: "faith that shows up",
      hook: "Nobody talks about this but faith without action is just agreement.",
      rationale: "The teaching point is concise, grounded, and practical for short-form video.",
      postCaption: "Faith becomes real in the next ordinary decision you make."
    })
  ].map((clip) => generatedClipSchema.parse(clip));

  return { sermon, job, clips };
}

function runFakeJob(initialJob: ProcessingJob): ProcessingJob {
  const moments: readonly [ProcessingJobStatus, string][] = [
    ["fetching_source", "2026-01-01T00:00:01.000Z"],
    ["transcribing", "2026-01-01T00:00:02.000Z"],
    ["selecting_clips", "2026-01-01T00:00:03.000Z"],
    ["rendering_clips", "2026-01-01T00:00:04.000Z"],
    ["completed", "2026-01-01T00:00:05.000Z"]
  ];
  const events = [
    "start_source_fetch",
    "source_fetched",
    "transcript_ready",
    "clips_selected",
    "rendering_finished"
  ] as const;

  return events.reduce<ProcessingJob>((job, event, index) => {
    const result = transitionProcessingJob(job, event, moments[index]?.[1] ?? job.updatedAt);
    if (!result.ok) {
      throw new Error(`Invalid fake job transition from ${result.error.currentStatus}`);
    }
    return result.value;
  }, initialJob);
}

function buildClip(input: {
  readonly id: string;
  readonly sermonId: string;
  readonly category: "invitation" | "encouragement" | "teaching";
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly title: string;
  readonly hook: string;
  readonly rationale: string;
  readonly postCaption: string;
}): GeneratedClip {
  const candidate = clipCandidateSchema.parse({
    ...input,
    confidence: 0.82,
    promptVersion: "fake-stage-1-v1",
    model: "deterministic-fake"
  });
  return {
    candidate,
    renderedClip: {
      clipCandidateId: candidate.id,
      format: "mp4",
      aspectRatio: "9:16",
      cropVideoUrl: `https://example.com/fake-renders/${candidate.id}-crop.mp4`,
      blurVideoUrl: `https://example.com/fake-renders/${candidate.id}-blur.mp4`,
      thumbnailUrl: `https://example.com/fake-renders/${candidate.id}.jpg`,
      subtitleStyle: "bold-readable",
      renderStatus: "completed",
      previewStartSeconds: 0
    }
  };
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
