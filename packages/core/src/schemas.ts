import { z } from "zod";
import { processingJobStatusSchema } from "./processing-job.js";

export const clipCategorySchema = z.enum([
  "invitation",
  "encouragement",
  "teaching",
  "quote",
  "recap"
]);

export type ClipCategory = z.infer<typeof clipCategorySchema>;

export const youtubeUrlSchema = z
  .string()
  .pipe(z.url())
  .refine((value) => {
    const url = new URL(value);
    const hostname = url.hostname.replace(/^www\./, "");
    return hostname === "youtube.com" || hostname === "youtu.be";
  }, "Expected a YouTube URL");

export const submitSermonSchema = z.object({
  sourceUrl: youtubeUrlSchema,
  clipCount: z.number().int().min(1).max(12).default(6)
});

export type SubmitSermonInput = z.infer<typeof submitSermonSchema>;

export const submissionAcceptedSchema = z.object({
  sermonId: z.string().min(1),
  jobId: z.string().min(1),
  status: processingJobStatusSchema,
  youtubeContentId: z.string().min(1),
  runNumber: z.number().int().positive()
});

export type SubmissionAccepted = z.infer<typeof submissionAcceptedSchema>;

export const transcriptSegmentSchema = z
  .object({
    startSeconds: z.number().nonnegative(),
    endSeconds: z.number().positive(),
    text: z.string().min(1)
  })
  .refine((segment) => segment.endSeconds > segment.startSeconds, {
    message: "Transcript segment must end after it starts",
    path: ["endSeconds"]
  });

export const transcriptSchema = z.object({
  sermonId: z.string().min(1),
  language: z.string().min(2),
  segments: z.array(transcriptSegmentSchema).min(1)
});

export type Transcript = z.infer<typeof transcriptSchema>;

/**
 * A span of a clip, in clip-relative seconds (t=0 at the clip start), that should be
 * rendered in blur-pad mode instead of the default close-up crop. Time outside every
 * span is rendered crop-fill.
 */
export const blurPadSpanSchema = z
  .object({
    startSeconds: z.number().nonnegative(),
    endSeconds: z.number().positive()
  })
  .refine((span) => span.endSeconds > span.startSeconds, {
    message: "Blur-pad span must end after it starts",
    path: ["endSeconds"]
  });

export type BlurPadSpan = z.infer<typeof blurPadSpanSchema>;

const blurPadSpansSchema = z
  .array(blurPadSpanSchema)
  .default([])
  .refine(
    (spans) =>
      spans.every((span, index) => {
        const previous = spans[index - 1];
        return previous === undefined || span.startSeconds >= previous.endSeconds;
      }),
    { message: "Blur-pad spans must be sorted and non-overlapping" }
  );

export const clipCandidateSchema = z
  .object({
    id: z.string().min(1),
    sermonId: z.string().min(1),
    startSeconds: z.number().nonnegative(),
    endSeconds: z.number().positive(),
    title: z.string().min(1),
    hook: z.string().min(1),
    rationale: z.string().min(1),
    postCaption: z.string().min(1),
    firstWords: z.string().optional(),
    lastWords: z.string().optional(),
    confidence: z.number().min(0).max(1),
    promptVersion: z.string().min(1),
    model: z.string().min(1),
    blurPadSpans: blurPadSpansSchema
  })
  .refine((clip) => clip.endSeconds > clip.startSeconds, {
    message: "Clip candidate must end after it starts",
    path: ["endSeconds"]
  });

export type ClipCandidate = z.infer<typeof clipCandidateSchema>;

export const renderedClipSchema = z.object({
  clipCandidateId: z.string().min(1),
  format: z.literal("mp4"),
  aspectRatio: z.literal("9:16"),
  // Both full-length variants are rendered up front so the editor can preview either
  // instantly. finalVideoUrl is the stitched result, set on download for mixed plans.
  cropVideoUrl: z.url(),
  blurVideoUrl: z.url(),
  finalVideoUrl: z.url().optional(),
  thumbnailUrl: z.url(),
  subtitleStyle: z.string().min(1),
  renderStatus: z.enum(["completed", "failed"]),
  // Optional buffered preview (crop only, ±bufferSeconds around the clip). When present,
  // the editor plays this file instead of cropVideoUrl so small timestamp adjustments
  // can be previewed instantly without a re-render. previewStartSeconds is the sermon-time
  // offset where the preview file begins, letting the player compute the clip's position
  // within the file.
  previewUrl: z.url().optional(),
  previewStartSeconds: z.number().nonnegative().optional()
});

export type RenderedClip = z.infer<typeof renderedClipSchema>;

export const sermonSchema = z.object({
  id: z.string().min(1),
  sourceType: z.literal("youtube_url"),
  sourceUrl: youtubeUrlSchema,
  title: z.string().min(1),
  speaker: z.string().min(1),
  durationSeconds: z.number().positive(),
  createdAt: z.iso.datetime(),
  clipCount: z.number().int().min(1).max(12).default(6)
});

export type Sermon = z.infer<typeof sermonSchema>;

export const generatedClipSchema = z.object({
  candidate: clipCandidateSchema,
  renderedClip: renderedClipSchema
});

export type GeneratedClip = z.infer<typeof generatedClipSchema>;
