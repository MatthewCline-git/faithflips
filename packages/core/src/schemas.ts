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
  runNumber: z.number().int().positive(),
  clipCount: z.number().int().min(1)
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
    model: z.string().min(1)
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
  cropVideoUrl: z.string().min(1),
  thumbnailUrl: z.string().min(1),
  subtitleStyle: z.string().min(1),
  renderStatus: z.enum(["completed", "failed"]),
  previewStartSeconds: z.number().nonnegative()
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
