import {
  clipCandidateSchema,
  err,
  ok,
  renderedClipSchema,
  transcriptSchema,
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
      readonly step: "video" | "thumbnail";
      readonly message: string;
      readonly exitCode?: number;
    }
  | {
      readonly type: "storage_upload_failed";
      readonly clipCandidateId: string;
      readonly asset: "video" | "thumbnail";
      readonly error: StorageError;
    }
  | {
      readonly type: "malformed_render_output";
      readonly clipCandidateId: string;
      readonly issues: readonly string[];
    };

export type VideoRenderer = {
  render(input: RenderClipInput): Promise<Result<RenderedClip, RenderError>>;
};

export function createFfmpegRenderer(input: {
  readonly commandRunner: CommandRunner;
  readonly storage: StorageClient;
  readonly workspace: RenderWorkspace;
  readonly ffmpegPath?: string;
  readonly logger?: (event: Record<string, unknown>) => void;
}): VideoRenderer {
  const ffmpegPath = input.ffmpegPath ?? "ffmpeg";
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
      const videoPath = input.workspace.createPath({
        clipCandidateId: `${candidate.id}-crop`,
        extension: "mp4"
      });
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

      const videoResult = await input.commandRunner.run(
        ffmpegPath,
        buildVideoArgs({
          candidate,
          sourceMedia,
          outputVideoPath: videoPath,
          subtitleStyle,
          ...(subtitlePath ? { subtitlePath } : {})
        })
      );
      if (!videoResult.ok || videoResult.value.exitCode !== 0) {
        const commandError = mapCommandFailure(videoResult);
        logger({
          event: "rendering_failed",
          clipCandidateId: candidate.id,
          step: "video",
          errorType: "render_failed",
          message: commandError.message,
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

      const videoObject = await input.storage.putObject({
        key: `renders/${candidate.sermonId}/${candidate.id}-crop.mp4`,
        filePath: videoPath,
        contentType: "video/mp4"
      });
      if (!videoObject.ok) {
        return err({
          type: "storage_upload_failed",
          clipCandidateId: candidate.id,
          asset: "video",
          error: videoObject.error
        });
      }

      const thumbnailResult = await input.commandRunner.run(
        ffmpegPath,
        buildThumbnailArgs({ candidate, sourceVideoPath: videoPath, outputThumbnailPath })
      );
      if (!thumbnailResult.ok || thumbnailResult.value.exitCode !== 0) {
        const commandError = mapCommandFailure(thumbnailResult);
        logger({
          event: "rendering_failed",
          clipCandidateId: candidate.id,
          step: "thumbnail",
          errorType: "render_failed",
          message: commandError.message,
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
        cropVideoUrl: videoObject.value.url,
        thumbnailUrl: thumbnailObject.value.url,
        subtitleStyle,
        renderStatus: "completed"
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
        thumbnailUrl: renderedClip.data.thumbnailUrl
      });
      return ok(renderedClip.data);
    }
  };
}

export function buildVideoArgs(input: {
  readonly candidate: ClipCandidate;
  readonly sourceMedia: SourceMediaAsset;
  readonly subtitlePath?: string;
  readonly outputVideoPath: string;
  readonly subtitleStyle: z.infer<typeof subtitleStyleSchema>;
}): readonly string[] {
  const startSeconds = input.candidate.startSeconds;
  const endSeconds = input.candidate.endSeconds;
  const videoFilter = cropFillFilter();
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

function cropFillFilter(): string {
  return "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920";
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
