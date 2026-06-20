import { err, ok, type Result, type Transcript } from "@faithflips/core";
import type {
  SourceMediaAsset,
  SourceMediaClient,
  SourceMediaError,
  SourceMediaMetadata,
  SourceMediaInput
} from "./source-media.js";
import type {
  TranscriptionError,
  TranscriptionProvider,
  TranscriptionProviderMetadata
} from "./transcription.js";

export type TranscriptIngestionInput = SourceMediaInput & {
  readonly sermonId: string;
  readonly languageHint?: string;
};

export type TranscriptIngestionOutput = {
  readonly metadata: SourceMediaMetadata;
  readonly media: SourceMediaAsset;
  readonly transcript: Transcript;
  readonly transcription: TranscriptionProviderMetadata;
};

export type TranscriptIngestionError =
  | {
      readonly type: "source_media_failed";
      readonly step: "metadata" | "media";
      readonly error: SourceMediaError;
    }
  | {
      readonly type: "transcription_failed";
      readonly error: TranscriptionError;
    };

export type TranscriptIngestionWorkflow = {
  ingestTranscript(
    input: TranscriptIngestionInput
  ): Promise<Result<TranscriptIngestionOutput, TranscriptIngestionError>>;
};

export function createTranscriptIngestionWorkflow(input: {
  readonly sourceMedia: SourceMediaClient;
  readonly transcription: TranscriptionProvider;
  readonly logger?: (event: Record<string, unknown>) => void;
}): TranscriptIngestionWorkflow {
  const logger = input.logger ?? (() => undefined);

  return {
    async ingestTranscript(workflowInput) {
      logger({
        event: "source_fetch_started",
        sermonId: workflowInput.sermonId,
        sourceType: "youtube_url"
      });

      const [metadata, media] = await Promise.all([
        input.sourceMedia.getMetadata(workflowInput),
        input.sourceMedia.getMedia(workflowInput)
      ]);

      if (!metadata.ok) {
        logger({
          event: "source_fetch_failed",
          sermonId: workflowInput.sermonId,
          step: "metadata",
          errorType: metadata.error.type
        });
        return err({ type: "source_media_failed", step: "metadata", error: metadata.error });
      }

      if (!media.ok) {
        logger({
          event: "source_fetch_failed",
          sermonId: workflowInput.sermonId,
          step: "media",
          errorType: media.error.type
        });
        return err({ type: "source_media_failed", step: "media", error: media.error });
      }

      logger({
        event: "source_fetch_completed",
        sermonId: workflowInput.sermonId,
        videoId: metadata.value.videoId
      });
      logger({
        event: "transcription_started",
        sermonId: workflowInput.sermonId,
        provider: input.transcription.provider,
        model: input.transcription.model
      });

      const transcript = await input.transcription.transcribe({
        sermonId: workflowInput.sermonId,
        media: media.value,
        languageHint: workflowInput.languageHint
      });
      if (!transcript.ok) {
        logger({
          event: "transcription_failed",
          sermonId: workflowInput.sermonId,
          provider: input.transcription.provider,
          model: input.transcription.model,
          errorType: transcript.error.type
        });
        return err({ type: "transcription_failed", error: transcript.error });
      }

      logger({
        event: "transcription_completed",
        sermonId: workflowInput.sermonId,
        provider: input.transcription.provider,
        model: input.transcription.model,
        segmentCount: transcript.value.transcript.segments.length
      });

      return ok({
        metadata: metadata.value,
        media: media.value,
        transcript: transcript.value.transcript,
        transcription: transcript.value.metadata
      });
    }
  };
}
