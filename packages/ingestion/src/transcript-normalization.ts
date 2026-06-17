import { err, ok, transcriptSchema, type Result, type Transcript } from "@faithflips/core";
import { z } from "zod";

export const rawTranscriptSegmentSchema = z.object({
  startSeconds: z.number().nonnegative(),
  endSeconds: z.number().positive(),
  text: z.string()
});

export const rawTranscriptSchema = z.object({
  sermonId: z.string().min(1),
  language: z.string().min(2).default("en"),
  segments: z.array(rawTranscriptSegmentSchema).min(1)
});

export type RawTranscriptSegment = z.infer<typeof rawTranscriptSegmentSchema>;
export type RawTranscript = z.infer<typeof rawTranscriptSchema>;

export type TranscriptValidationError = {
  readonly type: "invalid_transcript";
  readonly sermonId?: string;
  readonly issues: readonly string[];
};

export function normalizeTranscriptSegments(
  input: RawTranscript
): Result<Transcript, TranscriptValidationError> {
  const parsed = rawTranscriptSchema.safeParse(input);
  if (!parsed.success) {
    const sermonId = typeof input.sermonId === "string" ? input.sermonId : undefined;
    return err({
      type: "invalid_transcript",
      ...(sermonId === undefined ? {} : { sermonId }),
      issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    });
  }

  const normalizedSegments = parsed.data.segments
    .map((segment) => ({
      startSeconds: roundTimestamp(segment.startSeconds),
      endSeconds: roundTimestamp(segment.endSeconds),
      text: normalizeWhitespace(segment.text)
    }))
    .filter((segment) => segment.text.length > 0)
    .sort(
      (left, right) => left.startSeconds - right.startSeconds || left.endSeconds - right.endSeconds
    );

  const transcript = transcriptSchema.safeParse({
    sermonId: parsed.data.sermonId,
    language: parsed.data.language.trim().toLowerCase(),
    segments: normalizedSegments
  });

  if (!transcript.success) {
    return err({
      type: "invalid_transcript",
      sermonId: parsed.data.sermonId,
      issues: transcript.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    });
  }

  const orderingIssues = validateSegmentOrdering(transcript.data);
  if (orderingIssues.length > 0) {
    return err({
      type: "invalid_transcript",
      sermonId: parsed.data.sermonId,
      issues: orderingIssues
    });
  }

  return ok(transcript.data);
}

function validateSegmentOrdering(transcript: Transcript): readonly string[] {
  const issues: string[] = [];
  let previousEnd = 0;

  transcript.segments.forEach((segment, index) => {
    if (index > 0 && segment.startSeconds < previousEnd) {
      issues.push(`segments.${String(index)}: Transcript segments must not overlap`);
    }
    previousEnd = segment.endSeconds;
  });

  return issues;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function roundTimestamp(value: number): number {
  return Math.round(value * 1000) / 1000;
}
