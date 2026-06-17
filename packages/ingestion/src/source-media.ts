import { err, ok, youtubeUrlSchema, type Result } from "@faithflips/core";
import { z } from "zod";

export const sourceMediaInputSchema = z.object({
  sourceUrl: youtubeUrlSchema
});

export const sourceMediaMetadataSchema = z.object({
  sourceType: z.literal("youtube_url"),
  sourceUrl: youtubeUrlSchema,
  videoId: z.string().min(1),
  title: z.string().min(1),
  authorName: z.string().min(1),
  providerName: z.string().min(1),
  thumbnailUrl: z.url().optional(),
  fetchedAt: z.iso.datetime()
});

export const sourceMediaAssetSchema = z.object({
  sourceType: z.literal("youtube_url"),
  sourceUrl: youtubeUrlSchema,
  videoId: z.string().min(1),
  mediaUrl: z.string().min(1),
  access: z.literal("remote_reference")
});

const youtubeOEmbedSchema = z.object({
  title: z.string().min(1),
  author_name: z.string().min(1),
  provider_name: z.string().min(1),
  thumbnail_url: z.url().optional()
});

export type SourceMediaInput = z.infer<typeof sourceMediaInputSchema>;
export type SourceMediaMetadata = z.infer<typeof sourceMediaMetadataSchema>;
export type SourceMediaAsset = z.infer<typeof sourceMediaAssetSchema>;

export type SourceMediaError =
  | {
      readonly type: "invalid_source_url";
      readonly sourceUrl: string;
      readonly message: string;
    }
  | {
      readonly type: "source_unavailable";
      readonly sourceUrl: string;
      readonly provider: "youtube";
      readonly message: string;
      readonly status?: number;
    }
  | {
      readonly type: "malformed_source_metadata";
      readonly sourceUrl: string;
      readonly provider: "youtube";
      readonly issues: readonly string[];
    };

export type SourceMediaClient = {
  getMetadata(input: SourceMediaInput): Promise<Result<SourceMediaMetadata, SourceMediaError>>;
  getMedia(input: SourceMediaInput): Promise<Result<SourceMediaAsset, SourceMediaError>>;
};

export type FetchLike = (
  input: string,
  init?: { readonly headers?: Record<string, string> }
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}>;

export function createYouTubeSourceMediaClient(input: {
  readonly fetch: FetchLike;
  readonly now?: () => Date;
}): SourceMediaClient {
  const now = input.now ?? (() => new Date());

  return {
    async getMetadata(mediaInput) {
      const parsedInput = sourceMediaInputSchema.safeParse(mediaInput);
      if (!parsedInput.success) {
        return invalidSourceUrl(mediaInput.sourceUrl, parsedInput.error.issues[0]?.message);
      }

      const videoIdResult = parseYouTubeVideoId(parsedInput.data.sourceUrl);
      if (!videoIdResult.ok) {
        return videoIdResult;
      }

      const endpoint = new URL("https://www.youtube.com/oembed");
      endpoint.searchParams.set("url", parsedInput.data.sourceUrl);
      endpoint.searchParams.set("format", "json");

      try {
        const response = await input.fetch(endpoint.toString(), {
          headers: { accept: "application/json" }
        });
        if (!response.ok) {
          return err({
            type: "source_unavailable",
            sourceUrl: parsedInput.data.sourceUrl,
            provider: "youtube",
            message: "YouTube metadata request failed",
            status: response.status
          });
        }

        const rawMetadata = await response.json();
        const parsedMetadata = youtubeOEmbedSchema.safeParse(rawMetadata);
        if (!parsedMetadata.success) {
          return err({
            type: "malformed_source_metadata",
            sourceUrl: parsedInput.data.sourceUrl,
            provider: "youtube",
            issues: parsedMetadata.error.issues.map(
              (issue) => `${issue.path.join(".")}: ${issue.message}`
            )
          });
        }

        const metadata = sourceMediaMetadataSchema.parse({
          sourceType: "youtube_url",
          sourceUrl: parsedInput.data.sourceUrl,
          videoId: videoIdResult.value,
          title: parsedMetadata.data.title,
          authorName: parsedMetadata.data.author_name,
          providerName: parsedMetadata.data.provider_name,
          thumbnailUrl: parsedMetadata.data.thumbnail_url,
          fetchedAt: now().toISOString()
        });
        return ok(metadata);
      } catch (error) {
        return err({
          type: "source_unavailable",
          sourceUrl: parsedInput.data.sourceUrl,
          provider: "youtube",
          message: error instanceof Error ? error.message : "Unknown YouTube metadata failure"
        });
      }
    },

    getMedia(mediaInput) {
      const parsedInput = sourceMediaInputSchema.safeParse(mediaInput);
      if (!parsedInput.success) {
        return Promise.resolve(
          invalidSourceUrl(mediaInput.sourceUrl, parsedInput.error.issues[0]?.message)
        );
      }

      const videoIdResult = parseYouTubeVideoId(parsedInput.data.sourceUrl);
      if (!videoIdResult.ok) {
        return Promise.resolve(videoIdResult);
      }

      return Promise.resolve(
        ok(
          sourceMediaAssetSchema.parse({
            sourceType: "youtube_url",
            sourceUrl: parsedInput.data.sourceUrl,
            videoId: videoIdResult.value,
            mediaUrl: parsedInput.data.sourceUrl,
            access: "remote_reference"
          })
        )
      );
    }
  };
}

export function parseYouTubeVideoId(sourceUrl: string): Result<string, SourceMediaError> {
  const parsed = youtubeUrlSchema.safeParse(sourceUrl);
  if (!parsed.success) {
    return invalidSourceUrl(sourceUrl, parsed.error.issues[0]?.message);
  }

  const url = new URL(parsed.data);
  const hostname = url.hostname.replace(/^www\./, "");
  const videoId =
    hostname === "youtu.be"
      ? url.pathname.split("/").filter(Boolean)[0]
      : url.searchParams.get("v");

  if (!videoId) {
    return invalidSourceUrl(sourceUrl, "Expected a YouTube video id");
  }

  return ok(videoId);
}

function invalidSourceUrl(
  sourceUrl: string,
  message = "Invalid YouTube source URL"
): Result<never, SourceMediaError> {
  return err({ type: "invalid_source_url", sourceUrl, message });
}
