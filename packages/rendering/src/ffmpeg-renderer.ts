import {
  clipCandidateSchema,
  err,
  ok,
  renderedClipSchema,
  transcriptSchema,
  type BlurPadSpan,
  type ClipCandidate,
  type RenderedClip,
  type Result
} from "@faithflips/core";
import { sourceMediaAssetSchema, type SourceMediaAsset } from "@faithflips/ingestion";
import { z } from "zod";
import { buildSubtitleCues, renderSrt } from "./subtitles.js";
import type { StorageClient, StorageError } from "./storage.js";

const subtitleStyleSchema = z.enum(["bold-readable", "clean-readable"]);

export const renderClipInputSchema = z.object({
  candidate: clipCandidateSchema,
  transcript: transcriptSchema,
  sourceMedia: sourceMediaAssetSchema,
  subtitleStyle: subtitleStyleSchema.default("bold-readable"),
  burnSubtitles: z.boolean().default(false)
});

export type RenderClipInput = z.input<typeof renderClipInputSchema>;

export type CommandResult = {
  readonly exitCode: number;
  readonly stderr?: string;
};

export type CommandRunner = {
  run(command: string, args: readonly string[]): Promise<Result<CommandResult, CommandRunnerError>>;
};

export type CommandRunnerError = {
  readonly type: "command_failed";
  readonly command: string;
  readonly message: string;
  readonly exitCode?: number;
};

export type RenderWorkspace = {
  createPath(input: {
    readonly clipCandidateId: string;
    readonly extension: "mp4" | "jpg" | "srt";
  }): string;
  writeTextFile(
    path: string,
    content: string
  ): Promise<Result<{ readonly path: string }, WorkspaceError>>;
};

export type WorkspaceError = {
  readonly type: "workspace_write_failed";
  readonly path: string;
  readonly message: string;
};

export type RenderError =
  | {
      readonly type: "invalid_render_input";
      readonly clipCandidateId?: string;
      readonly issues: readonly string[];
    }
  | {
      readonly type: "subtitle_write_failed";
      readonly clipCandidateId: string;
      readonly error: WorkspaceError;
    }
  | {
      readonly type: "render_failed";
      readonly clipCandidateId: string;
      readonly step: "video" | "thumbnail" | "stitch";
      readonly message: string;
      readonly exitCode?: number;
    }
  | {
      readonly type: "storage_upload_failed";
      readonly clipCandidateId: string;
      readonly asset: "video" | "thumbnail" | "final";
      readonly error: StorageError;
    }
  | {
      readonly type: "malformed_render_output";
      readonly clipCandidateId: string;
      readonly issues: readonly string[];
    };

export type FillMode = "crop-fill" | "blur-pad";

export type StitchInput = {
  readonly candidate: ClipCandidate;
  readonly blurPadSpans: readonly BlurPadSpan[];
};

export type VideoRenderer = {
  render(input: RenderClipInput): Promise<Result<RenderedClip, RenderError>>;
  stitch(input: StitchInput): Promise<Result<{ readonly finalVideoUrl: string }, RenderError>>;
};

export function createFfmpegRenderer(input: {
  readonly commandRunner: CommandRunner;
  readonly storage: StorageClient;
  readonly workspace: RenderWorkspace;
  readonly ffmpegPath?: string;
  readonly bufferSeconds?: number;
  readonly logger?: (event: Record<string, unknown>) => void;
}): VideoRenderer {
  const ffmpegPath = input.ffmpegPath ?? "ffmpeg";
  const bufferSeconds = input.bufferSeconds ?? 10;
  const logger = input.logger ?? (() => undefined);

  return {
    async render(renderInput) {
      const parsedInput = renderClipInputSchema.safeParse(renderInput);
      if (!parsedInput.success) {
        return err({
          type: "invalid_render_input",
          clipCandidateId: renderInput.candidate.id,
          issues: parsedInput.error.issues.map(
            (issue) => `${issue.path.join(".")}: ${issue.message}`
          )
        });
      }

      const { candidate, transcript, sourceMedia, subtitleStyle, burnSubtitles } = parsedInput.data;
      const cropVideoPath = variantPath(input.workspace, candidate.id, "crop");
      const blurVideoPath = variantPath(input.workspace, candidate.id, "blur");
      const outputThumbnailPath = input.workspace.createPath({
        clipCandidateId: candidate.id,
        extension: "jpg"
      });

      let subtitlePath: string | undefined;
      if (burnSubtitles) {
        subtitlePath = input.workspace.createPath({
          clipCandidateId: candidate.id,
          extension: "srt"
        });
        const subtitleWrite = await input.workspace.writeTextFile(
          subtitlePath,
          renderSrt(buildSubtitleCues({ candidate, transcript }))
        );
        if (!subtitleWrite.ok) {
          logger({
            event: "rendering_failed",
            clipCandidateId: candidate.id,
            step: "subtitles",
            errorType: subtitleWrite.error.type
          });
          return err({
            type: "subtitle_write_failed",
            clipCandidateId: candidate.id,
            error: subtitleWrite.error
          });
        }
      }

      logger({
        event: "rendering_started",
        clipCandidateId: candidate.id,
        sourceType: sourceMedia.sourceType,
        format: "mp4",
        aspectRatio: "9:16"
      });

      // Render both full-length variants and the buffered preview concurrently — all read
      // from the same source file and write to separate output paths so there's no conflict.
      const previewStart = Math.max(0, candidate.startSeconds - bufferSeconds);
      const previewEnd = candidate.endSeconds + bufferSeconds;
      const previewVideoPath = variantPath(input.workspace, candidate.id, "preview");

      const [cropUrl, blurUrl, previewUrl] = await Promise.all([
        renderAndUpload({
          mode: "crop-fill",
          outputVideoPath: cropVideoPath,
          key: `renders/${candidate.sermonId}/${candidate.id}-crop.mp4`
        }),
        renderAndUpload({
          mode: "blur-pad",
          outputVideoPath: blurVideoPath,
          key: `renders/${candidate.sermonId}/${candidate.id}-blur.mp4`
        }),
        // Best-effort buffered preview: ±bufferSeconds around the clip for instant scrubbing.
        // Failure is non-fatal — crop/blur still work.
        (async (): Promise<string | undefined> => {
          const result = await input.commandRunner.run(
            ffmpegPath,
            buildVideoArgs({
              candidate,
              sourceMedia,
              mode: "crop-fill",
              outputVideoPath: previewVideoPath,
              subtitleStyle,
              startOverride: previewStart,
              endOverride: previewEnd
            })
          );
          if (!result.ok || result.value.exitCode !== 0) return undefined;
          const upload = await input.storage.putObject({
            key: `renders/${candidate.sermonId}/${candidate.id}-preview.mp4`,
            filePath: previewVideoPath,
            contentType: "video/mp4"
          });
          return upload.ok ? upload.value.url : undefined;
        })()
      ]);

      if (!cropUrl.ok) return cropUrl;
      if (!blurUrl.ok) return blurUrl;

      const thumbnailResult = await input.commandRunner.run(
        ffmpegPath,
        buildThumbnailArgs({ candidate, sourceVideoPath: cropVideoPath, outputThumbnailPath })
      );
      if (!thumbnailResult.ok || thumbnailResult.value.exitCode !== 0) {
        const commandError = mapCommandFailure(thumbnailResult);
        logger({
          event: "rendering_failed",
          clipCandidateId: candidate.id,
          step: "thumbnail",
          errorType: "render_failed",
          exitCode: commandError.exitCode
        });
        return err({
          type: "render_failed",
          clipCandidateId: candidate.id,
          step: "thumbnail",
          message: commandError.message,
          ...optionalExitCode(commandError.exitCode)
        });
      }

      const thumbnailObject = await input.storage.putObject({
        key: `renders/${candidate.sermonId}/${candidate.id}.jpg`,
        filePath: outputThumbnailPath,
        contentType: "image/jpeg"
      });
      if (!thumbnailObject.ok) {
        return err({
          type: "storage_upload_failed",
          clipCandidateId: candidate.id,
          asset: "thumbnail",
          error: thumbnailObject.error
        });
      }

      const renderedClip = renderedClipSchema.safeParse({
        clipCandidateId: candidate.id,
        format: "mp4",
        aspectRatio: "9:16",
        cropVideoUrl: cropUrl.value,
        blurVideoUrl: blurUrl.value,
        thumbnailUrl: thumbnailObject.value.url,
        subtitleStyle,
        renderStatus: "completed",
        ...(previewUrl ? { previewUrl, previewStartSeconds: previewStart } : {})
      });
      if (!renderedClip.success) {
        return err({
          type: "malformed_render_output",
          clipCandidateId: candidate.id,
          issues: renderedClip.error.issues.map(
            (issue) => `${issue.path.join(".")}: ${issue.message}`
          )
        });
      }

      logger({
        event: "rendering_completed",
        clipCandidateId: candidate.id,
        cropVideoUrl: renderedClip.data.cropVideoUrl,
        blurVideoUrl: renderedClip.data.blurVideoUrl,
        thumbnailUrl: renderedClip.data.thumbnailUrl
      });
      return ok(renderedClip.data);

      async function renderAndUpload(variant: {
        readonly mode: FillMode;
        readonly outputVideoPath: string;
        readonly key: string;
      }): Promise<Result<string, RenderError>> {
        const result = await input.commandRunner.run(
          ffmpegPath,
          buildVideoArgs({
            candidate,
            sourceMedia,
            mode: variant.mode,
            outputVideoPath: variant.outputVideoPath,
            subtitleStyle,
            ...(subtitlePath ? { subtitlePath } : {})
          })
        );
        if (!result.ok || result.value.exitCode !== 0) {
          const commandError = mapCommandFailure(result);
          logger({
            event: "rendering_failed",
            clipCandidateId: candidate.id,
            step: "video",
            mode: variant.mode,
            errorType: "render_failed",
            exitCode: commandError.exitCode
          });
          return err({
            type: "render_failed",
            clipCandidateId: candidate.id,
            step: "video",
            message: commandError.message,
            ...optionalExitCode(commandError.exitCode)
          });
        }

        const object = await input.storage.putObject({
          key: variant.key,
          filePath: variant.outputVideoPath,
          contentType: "video/mp4"
        });
        if (!object.ok) {
          return err({
            type: "storage_upload_failed",
            clipCandidateId: candidate.id,
            asset: "video",
            error: object.error
          });
        }
        return ok(object.value.url);
      }
    },

    async stitch(stitchInput) {
      const { candidate } = stitchInput;
      const segments = buildFillSegments(
        stitchInput.blurPadSpans,
        candidate.endSeconds - candidate.startSeconds
      );

      const cropVideoPath = variantPath(input.workspace, candidate.id, "crop");
      const blurVideoPath = variantPath(input.workspace, candidate.id, "blur");
      const finalVideoPath = variantPath(input.workspace, candidate.id, "final");

      logger({
        event: "stitch_started",
        clipCandidateId: candidate.id,
        segmentCount: segments.length
      });

      const result = await input.commandRunner.run(
        ffmpegPath,
        buildStitchArgs({ cropVideoPath, blurVideoPath, finalVideoPath, segments })
      );
      if (!result.ok || result.value.exitCode !== 0) {
        const commandError = mapCommandFailure(result);
        logger({
          event: "rendering_failed",
          clipCandidateId: candidate.id,
          step: "stitch",
          errorType: "render_failed",
          exitCode: commandError.exitCode
        });
        return err({
          type: "render_failed",
          clipCandidateId: candidate.id,
          step: "stitch",
          message: commandError.message,
          ...optionalExitCode(commandError.exitCode)
        });
      }

      const object = await input.storage.putObject({
        key: `renders/${candidate.sermonId}/${candidate.id}-final.mp4`,
        filePath: finalVideoPath,
        contentType: "video/mp4"
      });
      if (!object.ok) {
        return err({
          type: "storage_upload_failed",
          clipCandidateId: candidate.id,
          asset: "final",
          error: object.error
        });
      }

      logger({
        event: "stitch_completed",
        clipCandidateId: candidate.id,
        finalVideoUrl: object.value.url
      });
      return ok({ finalVideoUrl: object.value.url });
    }
  };
}

function variantPath(
  workspace: RenderWorkspace,
  clipCandidateId: string,
  variant: "crop" | "blur" | "final" | "preview"
): string {
  return workspace.createPath({
    clipCandidateId: `${clipCandidateId}-${variant}`,
    extension: "mp4"
  });
}

export function buildVideoArgs(input: {
  readonly candidate: ClipCandidate;
  readonly sourceMedia: SourceMediaAsset;
  readonly mode: FillMode;
  readonly subtitlePath?: string;
  readonly outputVideoPath: string;
  readonly subtitleStyle: z.infer<typeof subtitleStyleSchema>;
  readonly startOverride?: number;
  readonly endOverride?: number;
}): readonly string[] {
  const startSeconds = input.startOverride ?? input.candidate.startSeconds;
  const endSeconds = input.endOverride ?? input.candidate.endSeconds;
  const videoFilter = input.mode === "blur-pad" ? staticBlurPadFilter() : cropFillFilter();
  const vf = input.subtitlePath
    ? `${videoFilter},${subtitleFilter(input.subtitlePath, input.subtitleStyle)}`
    : videoFilter;

  return [
    "-y",
    "-ss",
    secondsArg(startSeconds),
    "-to",
    secondsArg(endSeconds),
    "-i",
    input.sourceMedia.mediaUrl,
    "-vf",
    vf,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "23",
    "-c:a",
    "aac",
    "-movflags",
    "+faststart",
    input.outputVideoPath
  ];
}

export function buildThumbnailArgs(input: {
  readonly candidate: ClipCandidate;
  readonly sourceVideoPath: string;
  readonly outputThumbnailPath: string;
}): readonly string[] {
  // Grabbed from the already-rendered (1080x1920) crop clip, so no scaling is needed.
  const midpointSeconds = (input.candidate.endSeconds - input.candidate.startSeconds) / 2;
  return [
    "-y",
    "-ss",
    secondsArg(midpointSeconds),
    "-i",
    input.sourceVideoPath,
    "-frames:v",
    "1",
    input.outputThumbnailPath
  ];
}

/**
 * Builds the local stitch: a single re-encode that concatenates time slices, taking each
 * slice from the crop input (0) or blur input (1) per the contiguous segment plan. Video
 * comes from the trimmed/concatenated slices; audio is mapped straight from the crop input
 * (identical in both variants), so it stays continuous across cuts.
 */
export function buildStitchArgs(input: {
  readonly cropVideoPath: string;
  readonly blurVideoPath: string;
  readonly finalVideoPath: string;
  readonly segments: readonly FillSegment[];
}): readonly string[] {
  const trims = input.segments.map((segment, index) => {
    const inputIndex = segment.mode === "blur-pad" ? 1 : 0;
    return `[${String(inputIndex)}:v]trim=${secondsArg(segment.startSeconds)}:${secondsArg(segment.endSeconds)},setpts=PTS-STARTPTS[s${String(index)}]`;
  });
  const labels = input.segments.map((_, index) => `[s${String(index)}]`).join("");
  const filterComplex = `${trims.join(";")};${labels}concat=n=${String(input.segments.length)}:v=1:a=0[outv]`;

  return [
    "-y",
    "-i",
    input.cropVideoPath,
    "-i",
    input.blurVideoPath,
    "-filter_complex",
    filterComplex,
    "-map",
    "[outv]",
    "-map",
    "0:a?",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "23",
    "-c:a",
    "aac",
    "-movflags",
    "+faststart",
    input.finalVideoPath
  ];
}

/**
 * Contiguous fill-mode segments covering [0, duration] in clip-relative seconds. Blur-pad
 * spans are the overrides; everything else is the default close-up crop. Mirrors the web
 * editor's segmentsFromSpans so preview and final stitch agree.
 */
export function buildFillSegments(
  blurPadSpans: readonly BlurPadSpan[],
  duration: number
): readonly FillSegment[] {
  const segments: FillSegment[] = [];
  let cursor = 0;
  for (const span of blurPadSpans) {
    const start = Math.max(0, Math.min(span.startSeconds, duration));
    const end = Math.max(0, Math.min(span.endSeconds, duration));
    if (end <= start) continue;
    if (start > cursor) {
      segments.push({ startSeconds: cursor, endSeconds: start, mode: "crop-fill" });
    }
    segments.push({ startSeconds: start, endSeconds: end, mode: "blur-pad" });
    cursor = end;
  }
  if (cursor < duration || segments.length === 0) {
    segments.push({ startSeconds: cursor, endSeconds: duration, mode: "crop-fill" });
  }
  return segments;
}

type FillSegment = {
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly mode: FillMode;
};

function cropFillFilter(): string {
  return "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920";
}

/**
 * A still blur-pad frame (no time gating) for thumbnails: blurred zoomed background
 * with the aspect-preserved frame centered on top.
 */
function staticBlurPadFilter(): string {
  return [
    `split=2[bg][fg]`,
    `[bg]${cropFillFilter()},gblur=sigma=20[bgblur]`,
    `[fg]scale=1080:1920:force_original_aspect_ratio=decrease[fit]`,
    `[bgblur][fit]overlay=(W-w)/2:(H-h)/2`
  ].join(";");
}

function subtitleFilter(path: string, style: z.infer<typeof subtitleStyleSchema>): string {
  const forceStyle =
    style === "bold-readable"
      ? "FontName=Arial,FontSize=10,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Alignment=2,MarginV=120"
      : "FontName=Arial,FontSize=9,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Alignment=2,MarginV=110";

  return `subtitles=${escapeFfmpegFilterPath(path)}:force_style='${forceStyle}'`;
}

function secondsArg(seconds: number): string {
  return (Math.round(seconds * 1000) / 1000).toString();
}

function escapeFfmpegFilterPath(path: string): string {
  return path.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

function mapCommandFailure(result: Result<CommandResult, CommandRunnerError>): {
  readonly message: string;
  readonly exitCode?: number;
} {
  if (!result.ok) {
    return {
      message: result.error.message,
      ...optionalExitCode(result.error.exitCode)
    };
  }

  return {
    message: result.value.stderr ?? "ffmpeg exited with a non-zero status",
    exitCode: result.value.exitCode
  };
}

function optionalExitCode(exitCode: number | undefined): { readonly exitCode?: number } {
  return exitCode === undefined ? {} : { exitCode };
}
