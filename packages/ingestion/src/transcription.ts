import { err, ok, type Result, type Transcript } from "@faithflips/core";
import { z } from "zod";
import {
  normalizeTranscriptSegments,
  type RawTranscriptSegment,
  type TranscriptValidationError
} from "./transcript-normalization.js";
import { sourceMediaAssetSchema } from "./source-media.js";

export const transcriptionInputSchema = z.object({
  sermonId: z.string().min(1),
  media: sourceMediaAssetSchema,
  languageHint: z.string().min(2).optional()
});

export const transcriptionProviderMetadataSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  language: z.string().min(2),
  createdAt: z.iso.datetime()
});

export const transcriptionResponseSchema = z.object({
  transcript: z.custom<Transcript>(),
  metadata: transcriptionProviderMetadataSchema
});

export type TranscriptionInput = z.infer<typeof transcriptionInputSchema>;
export type TranscriptionProviderMetadata = z.infer<typeof transcriptionProviderMetadataSchema>;
export type TranscriptionResponse = z.infer<typeof transcriptionResponseSchema>;

export type TranscriptionError =
  | {
      readonly type: "transcript_unavailable";
      readonly provider: string;
      readonly model: string;
      readonly sermonId: string;
      readonly message: string;
    }
  | {
      readonly type: "malformed_transcript";
      readonly provider: string;
      readonly model: string;
      readonly sermonId: string;
      readonly issues: readonly string[];
    };

export type TranscriptionProvider = {
  readonly provider: string;
  readonly model: string;
  transcribe(input: TranscriptionInput): Promise<Result<TranscriptionResponse, TranscriptionError>>;
};

export function createDeterministicTranscriptionProvider(input?: {
  readonly provider?: string;
  readonly model?: string;
  readonly now?: () => Date;
  readonly segments?: readonly Readonly<RawTranscriptSegment>[];
}): TranscriptionProvider {
  const provider = input?.provider ?? "local";
  const model = input?.model ?? "deterministic-transcriber";
  const now = input?.now ?? (() => new Date());

  return {
    provider,
    model,
    transcribe(transcriptionInput) {
      const parsedInput = transcriptionInputSchema.safeParse(transcriptionInput);
      if (!parsedInput.success) {
        return Promise.resolve(
          err({
            type: "transcript_unavailable",
            provider,
            model,
            sermonId: transcriptionInput.sermonId,
            message: parsedInput.error.issues[0]?.message ?? "Invalid transcription input"
          })
        );
      }

      const normalized = normalizeTranscriptSegments({
        sermonId: parsedInput.data.sermonId,
        language: parsedInput.data.languageHint ?? "en",
        segments: [...(input?.segments ?? defaultSegmentsForVideo(parsedInput.data.media.videoId))]
      });

      if (!normalized.ok) {
        return Promise.resolve(
          malformedTranscript(provider, model, parsedInput.data.sermonId, normalized.error)
        );
      }

      return Promise.resolve(
        ok({
          transcript: normalized.value,
          metadata: transcriptionProviderMetadataSchema.parse({
            provider,
            model,
            language: normalized.value.language,
            createdAt: now().toISOString()
          })
        })
      );
    }
  };
}

function defaultSegmentsForVideo(videoId: string): readonly Readonly<RawTranscriptSegment>[] {
  return [
    {
      startSeconds: 0,
      endSeconds: 18,
      text: `Opening context for YouTube video ${videoId}.`
    },
    {
      startSeconds: 18,
      endSeconds: 52,
      text: "Grace meets tired people with hope and strength for today."
    },
    {
      startSeconds: 52,
      endSeconds: 96,
      text: "Faith becomes visible when it turns into practice in ordinary decisions."
    },
    {
      startSeconds: 96,
      endSeconds: 132,
      text: "Come respond to the invitation with a clear next step."
    }
  ];
}

function malformedTranscript(
  provider: string,
  model: string,
  sermonId: string,
  error: TranscriptValidationError
): Result<never, TranscriptionError> {
  return err({
    type: "malformed_transcript",
    provider,
    model,
    sermonId,
    issues: error.issues
  });
}
