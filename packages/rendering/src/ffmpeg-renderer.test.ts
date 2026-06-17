import { describe, expect, it } from "vitest";
import { clipCandidateSchema, ok, transcriptSchema, type Result } from "@faithflips/core";
import {
  buildFillSegments,
  buildStitchArgs,
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
  it("builds crop-fill video args that cut from source media and burn subtitles", () => {
    expect(
      buildVideoArgs({
        candidate,
        sourceMedia,
        mode: "crop-fill",
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

  it("builds a static blur-pad filtergraph for blur-pad mode (no time gating)", () => {
    const args = buildVideoArgs({
      candidate,
      sourceMedia,
      mode: "blur-pad",
      subtitlePath: "/tmp/clip_1.srt",
      outputVideoPath: "/tmp/clip_1-blur.mp4",
      subtitleStyle: "bold-readable"
    });
    const vf = args[args.indexOf("-vf") + 1] ?? "";

    expect(vf).toContain("gblur=sigma=20");
    expect(vf).toContain("overlay=(W-w)/2:(H-h)/2");
    expect(vf).not.toContain("enable=");
    expect(vf).toContain(",subtitles=/tmp/clip_1.srt");
  });

  it("uses the close-up crop filter for crop-fill mode", () => {
    const args = buildVideoArgs({
      candidate,
      sourceMedia,
      mode: "crop-fill",
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

  it("builds contiguous fill segments from blur-pad spans", () => {
    expect(buildFillSegments([{ startSeconds: 2, endSeconds: 4 }], 6)).toEqual([
      { startSeconds: 0, endSeconds: 2, mode: "crop-fill" },
      { startSeconds: 2, endSeconds: 4, mode: "blur-pad" },
      { startSeconds: 4, endSeconds: 6, mode: "crop-fill" }
    ]);
    expect(buildFillSegments([], 6)).toEqual([
      { startSeconds: 0, endSeconds: 6, mode: "crop-fill" }
    ]);
  });

  it("builds a trim+concat stitch from the crop and blur inputs", () => {
    const segments = buildFillSegments([{ startSeconds: 2, endSeconds: 4 }], 6);
    const args = buildStitchArgs({
      cropVideoPath: "/tmp/clip_1-crop.mp4",
      blurVideoPath: "/tmp/clip_1-blur.mp4",
      finalVideoPath: "/tmp/clip_1-final.mp4",
      segments
    });

    expect(args.slice(0, 5)).toEqual([
      "-y",
      "-i",
      "/tmp/clip_1-crop.mp4",
      "-i",
      "/tmp/clip_1-blur.mp4"
    ]);
    const filter = args[args.indexOf("-filter_complex") + 1] ?? "";
    // crop slice from input 0, blur slice from input 1, crop slice from input 0
    expect(filter).toContain("[0:v]trim=0:2,setpts=PTS-STARTPTS[s0]");
    expect(filter).toContain("[1:v]trim=2:4,setpts=PTS-STARTPTS[s1]");
    expect(filter).toContain("[0:v]trim=4:6,setpts=PTS-STARTPTS[s2]");
    expect(filter).toContain("[s0][s1][s2]concat=n=3:v=1:a=0[outv]");
    expect(args).toEqual(expect.arrayContaining(["-map", "[outv]", "0:a?"]));
    expect(args[args.length - 1]).toBe("/tmp/clip_1-final.mp4");
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
        blurVideoUrl: "https://cdn.example.test/renders/sermon_1/clip_1-blur.mp4",
        thumbnailUrl: "https://cdn.example.test/renders/sermon_1/clip_1.jpg",
        subtitleStyle: "bold-readable",
        renderStatus: "completed"
      }
    });
    // crop render, blur render, thumbnail
    expect(commands).toHaveLength(3);
    expect(commands[0]?.command).toBe("ffmpeg-test");
    expect(writtenFiles).toHaveLength(0);
    expect(events.map((event) => event["event"])).toEqual([
      "rendering_started",
      "rendering_completed"
    ]);
  });

  it("stitches the crop and blur variants for a mixed fill plan", async () => {
    const commands: Array<{ readonly command: string; readonly args: readonly string[] }> = [];
    const renderer = createFfmpegRenderer({
      ffmpegPath: "ffmpeg-test",
      commandRunner: {
        run(command, args) {
          commands.push({ command, args });
          return Promise.resolve(ok({ exitCode: 0 }));
        }
      },
      storage: createDeterministicStorageClient({ publicBaseUrl: "https://cdn.example.test" }),
      workspace: createWorkspace([])
    });

    const result = await renderer.stitch({
      candidate,
      blurPadSpans: [{ startSeconds: 5, endSeconds: 10 }]
    });

    expect(result).toEqual({
      ok: true,
      value: { finalVideoUrl: "https://cdn.example.test/renders/sermon_1/clip_1-final.mp4" }
    });
    expect(commands).toHaveLength(1);
    expect(commands[0]?.args).toEqual(expect.arrayContaining(["-filter_complex"]));
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
