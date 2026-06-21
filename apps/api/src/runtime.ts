import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { err, ok, type Result, type Transcript } from "@faithflips/core";
import {
  normalizeTranscriptSegments,
  parseYouTubeVideoId,
  transcriptionProviderMetadataSchema,
  type SourceMediaClient,
  type SourceMediaMetadata,
  type TranscriptionProvider
} from "@faithflips/ingestion";
import type {
  CommandRunner,
  CommandRunnerError,
  CommandResult,
  RenderWorkspace,
  StorageClient,
  StorageError,
  WorkspaceError
} from "@faithflips/rendering";

export function createSourceMediaClient(input: {
  readonly dataDir: string;
  readonly now: () => Date;
  readonly logger: (event: Record<string, unknown>) => void;
}): SourceMediaClient {
  return {
    async getMetadata(sourceInput) {
      const videoId = parseYouTubeVideoId(sourceInput.sourceUrl);
      if (!videoId.ok) {
        return videoId;
      }

      const metadataResult = await readYouTubeMetadata(sourceInput.sourceUrl);
      if (!metadataResult.ok) {
        return err({
          type: "source_unavailable",
          sourceUrl: sourceInput.sourceUrl,
          provider: "youtube",
          message: metadataResult.error.message
        });
      }

      const metadata: SourceMediaMetadata = {
        sourceType: "youtube_url",
        sourceUrl: sourceInput.sourceUrl,
        videoId: videoId.value,
        title: metadataResult.value.title,
        authorName: metadataResult.value.authorName,
        providerName: "YouTube",
        fetchedAt: input.now().toISOString()
      };
      return ok(metadata);
    },
    async getMedia(sourceInput) {
      const videoId = parseYouTubeVideoId(sourceInput.sourceUrl);
      if (!videoId.ok) {
        return videoId;
      }

      const sourceReady = await downloadYouTubeMedia({
        dataDir: input.dataDir,
        sourceUrl: sourceInput.sourceUrl,
        videoId: videoId.value,
        logger: input.logger
      });
      if (!sourceReady.ok) {
        return err({
          type: "source_unavailable",
          sourceUrl: sourceInput.sourceUrl,
          provider: "youtube",
          message: sourceReady.error.message
        });
      }

      return ok({
        sourceType: "youtube_url",
        sourceUrl: sourceInput.sourceUrl,
        videoId: videoId.value,
        mediaUrl: sourceReady.value.path,
        access: "remote_reference"
      });
    }
  };
}

export function createYtDlpTranscriptionProvider(input: {
  readonly dataDir: string;
  readonly now: () => Date;
  readonly logger: (event: Record<string, unknown>) => void;
}): TranscriptionProvider {
  return {
    provider: "yt-dlp",
    model: "youtube-captions",
    async transcribe(transcriptionInput) {
      const captions = await downloadYouTubeCaptions({
        dataDir: input.dataDir,
        sourceUrl: transcriptionInput.media.sourceUrl,
        videoId: transcriptionInput.media.videoId,
        logger: input.logger
      });
      if (!captions.ok) {
        return err({
          type: "transcript_unavailable",
          provider: "yt-dlp",
          model: "youtube-captions",
          sermonId: transcriptionInput.sermonId,
          message: captions.error.message
        });
      }

      const transcript = normalizeTranscriptSegments({
        sermonId: transcriptionInput.sermonId,
        language: transcriptionInput.languageHint ?? "en",
        segments: [...captions.value.segments]
      });
      if (!transcript.ok) {
        return err({
          type: "malformed_transcript",
          provider: "yt-dlp",
          model: "youtube-captions",
          sermonId: transcriptionInput.sermonId,
          issues: transcript.error.issues
        });
      }

      return ok({
        transcript: transcript.value,
        metadata: transcriptionProviderMetadataSchema.parse({
          provider: "yt-dlp",
          model: "youtube-captions",
          language: transcript.value.language,
          createdAt: input.now().toISOString()
        })
      });
    }
  };
}

export function createNodeCommandRunner(): CommandRunner {
  return {
    run(command, args) {
      return new Promise((resolve) => {
        const child = spawn(command, [...args], { stdio: ["ignore", "ignore", "pipe"] });
        const stderrChunks: Buffer[] = [];

        child.stderr.on("data", (chunk: Buffer) => {
          stderrChunks.push(chunk);
        });
        child.on("error", (error) => {
          resolve(
            err({
              type: "command_failed",
              command,
              message: error.message
            })
          );
        });
        child.on("close", (exitCode) => {
          const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
          const result: CommandResult =
            stderr.length > 0 ? { exitCode: exitCode ?? 1, stderr } : { exitCode: exitCode ?? 1 };
          resolve(ok(result));
        });
      });
    }
  };
}

export function createStorageClient(input: {
  readonly assetRoot: string;
}): StorageClient {
  return {
    async putObject(objectInput) {
      try {
        const outputPath = join(input.assetRoot, objectInput.key);
        await mkdir(dirname(outputPath), { recursive: true });
        await copyFile(objectInput.filePath, outputPath);
        return ok({
          key: objectInput.key,
          url: `/assets/${encodePathKey(objectInput.key)}`,
          contentType: objectInput.contentType
        });
      } catch (error) {
        return err({
          type: "storage_upload_failed",
          key: objectInput.key,
          message: error instanceof Error ? error.message : "Local storage copy failed"
        } satisfies StorageError);
      }
    }
  };
}

export function createRenderWorkspace(input: { readonly workDir: string }): RenderWorkspace {
  // Ensure the work directory exists so ffmpeg can write rendered outputs even on a
  // fresh/cleared data volume (createPath returns a path inside it without creating it).
  mkdirSync(input.workDir, { recursive: true });
  return {
    createPath(pathInput) {
      return join(input.workDir, `${pathInput.clipCandidateId}.${pathInput.extension}`);
    },
    async writeTextFile(path, content): Promise<Result<{ readonly path: string }, WorkspaceError>> {
      try {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, content);
        return ok({ path });
      } catch (error) {
        return err({
          type: "workspace_write_failed",
          path,
          message: error instanceof Error ? error.message : "Local workspace write failed"
        });
      }
    }
  };
}

type WhisperWord = {
  readonly word: string;
  readonly start: number;
  readonly end: number;
};

type WhisperSegment = {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly words?: readonly WhisperWord[];
};

type WhisperVerboseResponse = {
  readonly segments: readonly WhisperSegment[];
};

export function createWhisperTranscriptionProvider(input: {
  readonly dataDir: string;
  readonly apiKey: string;
  readonly now: () => Date;
  readonly logger: (event: Record<string, unknown>) => void;
}): TranscriptionProvider {
  return {
    provider: "openai",
    model: "whisper-1",
    async transcribe(transcriptionInput) {
      const audioDir = join(input.dataDir, "audio");
      await mkdir(audioDir, { recursive: true });

      const audioPath = join(audioDir, `${transcriptionInput.media.videoId}.mp3`);
      const cached = await findExistingFile(audioDir, `${transcriptionInput.media.videoId}.`);

      if (!cached) {
        input.logger({ event: "whisper_audio_extraction_started", videoId: transcriptionInput.media.videoId });
        const extract = await runCommand("ffmpeg", [
          "-i", transcriptionInput.media.mediaUrl,
          "-vn", "-ar", "16000", "-ac", "1", "-b:a", "32k",
          "-y", audioPath
        ]);
        if (!extract.ok || extract.value.exitCode !== 0) {
          const msg = extract.ok ? (extract.value.stderr ?? "Audio extraction failed") : extract.error.message;
          return err({ type: "transcript_unavailable", provider: "openai", model: "whisper-1", sermonId: transcriptionInput.sermonId, message: msg });
        }
        input.logger({ event: "whisper_audio_extraction_completed", videoId: transcriptionInput.media.videoId });
      } else {
        input.logger({ event: "whisper_audio_cache_hit", videoId: transcriptionInput.media.videoId });
      }

      input.logger({ event: "whisper_transcription_started", sermonId: transcriptionInput.sermonId });

      const audioData = await readFile(cached ?? audioPath);
      const form = new FormData();
      form.append("file", new Blob([audioData], { type: "audio/mpeg" }), "audio.mp3");
      form.append("model", "whisper-1");
      form.append("response_format", "verbose_json");
      form.append("timestamp_granularities[]", "segment");
      form.append("timestamp_granularities[]", "word");

      const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { authorization: `Bearer ${input.apiKey}` },
        body: form
      });

      if (!response.ok) {
        const detail = await response.text();
        return err({ type: "transcript_unavailable", provider: "openai", model: "whisper-1", sermonId: transcriptionInput.sermonId, message: `Whisper API ${String(response.status)}: ${detail}` });
      }

      const data = (await response.json()) as WhisperVerboseResponse;

      const segments = data.segments
        .map((s) => {
          const firstWord = s.words?.[0];
          const lastWord = s.words?.[s.words.length - 1];
          return {
            startSeconds: firstWord?.start ?? s.start,
            endSeconds: lastWord?.end ?? s.end,
            text: s.text.trim()
          };
        })
        .filter((s) => s.text.length > 0);

      input.logger({ event: "whisper_transcription_completed", sermonId: transcriptionInput.sermonId, segmentCount: segments.length });

      const normalized = normalizeTranscriptSegments({
        sermonId: transcriptionInput.sermonId,
        language: "en",
        segments
      });

      if (!normalized.ok) {
        return err({ type: "malformed_transcript", provider: "openai", model: "whisper-1", sermonId: transcriptionInput.sermonId, issues: normalized.error.issues });
      }

      return ok({
        transcript: normalized.value,
        metadata: transcriptionProviderMetadataSchema.parse({
          provider: "openai",
          model: "whisper-1",
          language: normalized.value.language,
          createdAt: input.now().toISOString()
        })
      });
    }
  };
}

async function downloadYouTubeMedia(input: {
  readonly dataDir: string;
  readonly sourceUrl: string;
  readonly videoId: string;
  readonly logger: (event: Record<string, unknown>) => void;
}): Promise<Result<{ readonly path: string }, CommandRunnerError>> {
  const mediaDir = join(input.dataDir, "source-media");
  await mkdir(mediaDir, { recursive: true });

  const existing = await findExistingFile(mediaDir, `${input.videoId}.`);
  if (existing) {
    input.logger({ event: "youtube_media_cache_hit", videoId: input.videoId, path: existing });
    return ok({ path: existing });
  }

  input.logger({ event: "youtube_media_download_started", videoId: input.videoId });
  const outputTemplate = join(mediaDir, `${input.videoId}.%(ext)s`);
  const result = await runCommand("yt-dlp", [
    "--force-overwrites",
    "--no-playlist",
    "-f",
    "bv*[height<=480][ext=mp4]+ba[ext=m4a]/bv*[height<=480]+ba[ext=m4a]/b[height<=480]/best[height<=480]",
    "--merge-output-format",
    "mp4",
    "--extractor-args",
    "youtube:player_client=tv_embed",
    "-o",
    outputTemplate,
    input.sourceUrl
  ]);
  if (!result.ok) {
    return result;
  }
  if (result.value.exitCode !== 0) {
    return err({
      type: "command_failed",
      command: "yt-dlp",
      message: result.value.stderr ?? "Failed to download YouTube media",
      exitCode: result.value.exitCode
    });
  }

  const downloaded = await findExistingFile(mediaDir, `${input.videoId}.`);
  if (!downloaded) {
    return err({
      type: "command_failed",
      command: "yt-dlp",
      message: "yt-dlp completed but no media file was found"
    });
  }

  input.logger({ event: "youtube_media_download_completed", videoId: input.videoId });
  return ok({ path: downloaded });
}

async function downloadYouTubeCaptions(input: {
  readonly dataDir: string;
  readonly sourceUrl: string;
  readonly videoId: string;
  readonly logger: (event: Record<string, unknown>) => void;
}): Promise<
  Result<{ readonly segments: readonly Transcript["segments"][number][] }, CommandRunnerError>
> {
  const captionsDir = join(input.dataDir, "captions");
  const existing = await findExistingFile(captionsDir, `${input.videoId}.en`);
  if (existing) {
    input.logger({ event: "youtube_captions_cache_hit", videoId: input.videoId });
    return parseCaptionFile(existing);
  }

  await mkdir(captionsDir, { recursive: true });
  input.logger({ event: "youtube_captions_download_started", videoId: input.videoId });
  const result = await runCommand("yt-dlp", [
    "--skip-download",
    "--write-subs",
    "--write-auto-subs",
    "--sub-langs",
    "en",
    "--sub-format",
    "vtt",
    "--no-playlist",
    "--extractor-args",
    "youtube:player_client=tv_embed",
    "-o",
    join(captionsDir, `${input.videoId}.%(ext)s`),
    input.sourceUrl
  ]);
  if (!result.ok) {
    return result;
  }
  if (result.value.exitCode !== 0) {
    return err({
      type: "command_failed",
      command: "yt-dlp",
      message: result.value.stderr ?? "Failed to download YouTube captions",
      exitCode: result.value.exitCode
    });
  }

  const captionPath = await findExistingFile(captionsDir, `${input.videoId}.en`);
  if (!captionPath) {
    return err({
      type: "command_failed",
      command: "yt-dlp",
      message: "No English captions were found for this video"
    });
  }

  input.logger({ event: "youtube_captions_download_completed", videoId: input.videoId });
  return parseCaptionFile(captionPath);
}

async function readYouTubeMetadata(
  sourceUrl: string
): Promise<Result<{ readonly title: string; readonly authorName: string }, CommandRunnerError>> {
  const result = await runCommand("yt-dlp", ["--dump-json", "--no-playlist", sourceUrl]);
  if (!result.ok) {
    return result;
  }
  if (result.value.exitCode !== 0 || !result.value.stdout) {
    return err({
      type: "command_failed",
      command: "yt-dlp",
      message: result.value.stderr ?? "Failed to read YouTube metadata",
      exitCode: result.value.exitCode
    });
  }

  try {
    const parsed = JSON.parse(result.value.stdout) as {
      readonly title?: unknown;
      readonly uploader?: unknown;
    };
    return ok({
      title:
        typeof parsed.title === "string" && parsed.title.length > 0
          ? parsed.title
          : "YouTube video",
      authorName:
        typeof parsed.uploader === "string" && parsed.uploader.length > 0
          ? parsed.uploader
          : "Unknown"
    });
  } catch (error) {
    return err({
      type: "command_failed",
      command: "yt-dlp",
      message: error instanceof Error ? error.message : "Failed to parse YouTube metadata"
    });
  }
}

async function parseCaptionFile(
  path: string
): Promise<
  Result<{ readonly segments: readonly Transcript["segments"][number][] }, CommandRunnerError>
> {
  const content = await readFile(path, "utf8");
  const segments = parseVtt(content);
  if (segments.length === 0) {
    return err({
      type: "command_failed",
      command: "yt-dlp",
      message: `Caption file ${basename(path)} did not contain transcript segments`
    });
  }
  return ok({ segments });
}

function parseVtt(content: string): Transcript["segments"] {
  const blocks = content.replace(/\r/g, "").split(/\n\n+/);
  const segments: Transcript["segments"] = [];

  for (const block of blocks) {
    const lines = block
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && line !== "WEBVTT" && !line.startsWith("Kind:"));
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex === -1) {
      continue;
    }

    const [startRaw, endRaw] = lines[timingIndex]?.split("-->").map((value) => value.trim()) ?? [];
    if (!startRaw || !endRaw) {
      continue;
    }
    const startSeconds = parseVttTimestamp(startRaw);
    const endSeconds = parseVttTimestamp(endRaw.split(/\s+/)[0] ?? "");
    const text = lines
      .slice(timingIndex + 1)
      .join(" ")
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .trim();

    if (startSeconds < endSeconds && text.length > 0) {
      segments.push({ startSeconds, endSeconds, text });
    }
  }

  return collapseDuplicateSegments(segments);
}

function parseVttTimestamp(value: string): number {
  const parts = value.split(":");
  const secondsPart = parts.at(-1) ?? "0";
  const minutesPart = parts.at(-2) ?? "0";
  const hoursPart = parts.length > 2 ? (parts.at(-3) ?? "0") : "0";
  return (
    Number.parseInt(hoursPart, 10) * 3600 +
    Number.parseInt(minutesPart, 10) * 60 +
    Number.parseFloat(secondsPart)
  );
}

function collapseDuplicateSegments(
  segments: readonly Transcript["segments"][number][]
): Transcript["segments"] {
  const collapsed: Transcript["segments"] = [];
  let lastText = "";
  for (const segment of segments) {
    if (segment.text === lastText) {
      continue;
    }
    collapsed.push(segment);
    lastText = segment.text;
  }
  return collapsed;
}

async function findExistingFile(directory: string, prefix: string): Promise<string | undefined> {
  try {
    const files = await readdir(directory);
    const file = files.find((item) => item.startsWith(prefix));
    return file ? join(directory, file) : undefined;
  } catch {
    return undefined;
  }
}

function runCommand(
  command: string,
  args: readonly string[]
): Promise<Result<CommandResult & { readonly stdout?: string }, CommandRunnerError>> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });
    child.on("error", (error) => {
      resolve(err({ type: "command_failed", command, message: error.message }));
    });
    child.on("close", (exitCode) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf8").trim();
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      resolve(
        ok({
          exitCode: exitCode ?? 1,
          ...(stdout.length > 0 ? { stdout } : {}),
          ...(stderr.length > 0 ? { stderr } : {})
        })
      );
    });
  });
}

function encodePathKey(key: string): string {
  return key
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}
