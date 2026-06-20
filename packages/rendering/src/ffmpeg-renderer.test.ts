import { describe, expect, it } from "vitest";
import { clipCandidateSchema, ok, transcriptSchema, type Result } from "@faithflips/core";
import {
  buildThumbnailArgs,
  buildVideoArgs,
  createFfmpegRenderer,
  type CommandRunner,
  type RenderWorkspace,
  type WorkspaceError
} from "./ffmpeg-renderer.js";
import { createDeterministicStorageClient } from "./storage.js";

const candidate = clipCandidateSchema.parse({
  id: "clip_1",
  sermonId: "sermon_1",
  category: "teaching",
  startSeconds: 12.3456,
  endSeconds: 52.9876,
  title: "Teaching",
  hook: "A useful hook",
  rationale: "This is a complete short teaching point.",
  postCaption: "A useful caption",
  confidence: 0.9,
  promptVersion: "v1",
  model: "model_1"
});

const sourceMedia = {
  sourceType: "youtube_url",
  sourceUrl: "https://www.youtube.com/watch?v=abc123",
  videoId: "abc123",
  mediaUrl: "https://www.youtube.com/watch?v=abc123",
  access: "remote_reference"
} as const;

const transcript = transcriptSchema.parse({
  sermonId: "sermon_1",
  language: "en",
  segments: [{ startSeconds: 12.5, endSeconds: 20, text: "God is near" }]
});

describe("ffmpeg renderer args", () => {
  it("builds video args that cut from source media and burn subtitles", () => {
    expect(
      buildVideoArgs({
        candidate,
        sourceMedia,
        subtitlePath: "/tmp/clip_1.srt",
        outputVideoPath: "/tmp/clip_1-crop.mp4",
        subtitleStyle: "bold-readable"
      })
    ).toEqual([
      "-y",
      "-ss",
      "12.346",
      "-to",
      "52.988",
      "-i",
      "https://www.youtube.com/watch?v=abc123",
      "-vf",
      expect.stringContaining(
        "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,subtitles=/tmp/clip_1.srt"
      ),
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
      "/tmp/clip_1-crop.mp4"
    ]);
  });

  it("uses the center-crop 16:9 filter", () => {
    const args = buildVideoArgs({
      candidate,
      sourceMedia,
      outputVideoPath: "/tmp/clip_1-crop.mp4",
      subtitleStyle: "bold-readable"
    });
    const vf = args[args.indexOf("-vf") + 1] ?? "";
    expect(vf).toBe("scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920");
  });

  it("builds thumbnail args from the rendered crop clip midpoint with no scaling", () => {
    expect(
      buildThumbnailArgs({
        candidate,
        sourceVideoPath: "/tmp/clip_1-crop.mp4",
        outputThumbnailPath: "/tmp/clip_1.jpg"
      })
    ).toEqual([
      "-y",
      "-ss",
      "20.321",
      "-i",
      "/tmp/clip_1-crop.mp4",
      "-frames:v",
      "1",
      "/tmp/clip_1.jpg"
    ]);
  });
});

describe("createFfmpegRenderer", () => {
  it("renders and stores downloadable video and thumbnail assets", async () => {
    const commands: Array<{ readonly command: string; readonly args: readonly string[] }> = [];
    const writtenFiles: Array<{ readonly path: string; readonly content: string }> = [];
    const events: Record<string, unknown>[] = [];
    const renderer = createFfmpegRenderer({
      ffmpegPath: "ffmpeg-test",
      commandRunner: {
        run(command, args) {
          commands.push({ command, args });
          return Promise.resolve(ok({ exitCode: 0 }));
        }
      },
      storage: createDeterministicStorageClient({
        publicBaseUrl: "https://cdn.example.test"
      }),
      workspace: createWorkspace(writtenFiles),
      logger: (event) => events.push(event)
    });

    const result = await renderer.render({ candidate, transcript, sourceMedia });

    expect(result).toEqual({
      ok: true,
      value: {
        clipCandidateId: "clip_1",
        format: "mp4",
        aspectRatio: "9:16",
        cropVideoUrl: "https://cdn.example.test/renders/sermon_1/clip_1-crop.mp4",
        thumbnailUrl: "https://cdn.example.test/renders/sermon_1/clip_1.jpg",
        subtitleStyle: "bold-readable",
        renderStatus: "completed"
      }
    });
    // video render + thumbnail
    expect(commands).toHaveLength(2);
    expect(commands[0]?.command).toBe("ffmpeg-test");
    expect(writtenFiles).toHaveLength(0);
    expect(events.map((event) => event["event"])).toEqual([
      "rendering_started",
      "rendering_completed"
    ]);
  });

  it("burns subtitles when burnSubtitles is true", async () => {
    const commands: Array<{ readonly command: string; readonly args: readonly string[] }> = [];
    const writtenFiles: Array<{ readonly path: string; readonly content: string }> = [];
    const renderer = createFfmpegRenderer({
      ffmpegPath: "ffmpeg-test",
      commandRunner: {
        run(command, args) {
          commands.push({ command, args });
          return Promise.resolve(ok({ exitCode: 0 }));
        }
      },
      storage: createDeterministicStorageClient({
        publicBaseUrl: "https://cdn.example.test"
      }),
      workspace: createWorkspace(writtenFiles)
    });

    const result = await renderer.render({
      candidate,
      transcript,
      sourceMedia,
      burnSubtitles: true
    });

    expect(result.ok).toBe(true);
    expect(writtenFiles[0]).toEqual({
      path: "/tmp/faithflips/clip_1.srt",
      content: "1\n00:00:00,154 --> 00:00:07,654\nGod is near\n"
    });
    expect(commands[0]?.args).toEqual(
      expect.arrayContaining([expect.stringContaining("subtitles=")])
    );
  });

  it("returns typed render failures for non-zero ffmpeg exits", async () => {
    const renderer = createFfmpegRenderer({
      commandRunner: {
        run(command, args) {
          void command;
          void args;
          return Promise.resolve(ok({ exitCode: 1, stderr: "bad input" }));
        }
      },
      storage: createDeterministicStorageClient(),
      workspace: createWorkspace([])
    });

    const result = await renderer.render({ candidate, transcript, sourceMedia });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({
        type: "render_failed",
        clipCandidateId: "clip_1",
        step: "video",
        message: "bad input",
        exitCode: 1
      });
    }
  });

  it("returns typed storage failures", async () => {
    const renderer = createFfmpegRenderer({
      commandRunner: createSuccessfulRunner(),
      storage: createDeterministicStorageClient({
        failKeys: ["renders/sermon_1/clip_1-crop.mp4"]
      }),
      workspace: createWorkspace([])
    });

    const result = await renderer.render({ candidate, transcript, sourceMedia });

    expect(result.ok).toBe(false);
    if (!result.ok && result.error.type === "storage_upload_failed") {
      expect(result.error.type).toBe("storage_upload_failed");
      expect(result.error.asset).toBe("video");
    }
  });
});

function createSuccessfulRunner(): CommandRunner {
  return {
    run(command, args) {
      void command;
      void args;
      return Promise.resolve(ok({ exitCode: 0 }));
    }
  };
}

function createWorkspace(
  writtenFiles: Array<{ readonly path: string; readonly content: string }>
): RenderWorkspace {
  return {
    createPath(input) {
      return `/tmp/faithflips/${input.clipCandidateId}.${input.extension}`;
    },
    writeTextFile(path, content): Promise<Result<{ readonly path: string }, WorkspaceError>> {
      writtenFiles.push({ path, content });
      return Promise.resolve(ok({ path }));
    }
  };
}
