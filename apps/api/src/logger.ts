const colors = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  red: "\x1b[31m",
  gray: "\x1b[90m"
} as const;

const STEP_LABELS: Record<number, string> = {
  1: "Submit",
  2: "Download",
  3: "Transcribe",
  4: "Select",
  5: "Render"
};

const STEP_MAP: Record<string, number> = {
  sermon_submitted: 1,
  job_recovery_started: 1,
  source_fetch_started: 2,
  youtube_media_download_started: 2,
  youtube_media_cache_hit: 2,
  youtube_media_download_completed: 2,
  youtube_captions_download_started: 2,
  youtube_captions_cache_hit: 2,
  youtube_captions_download_completed: 2,
  source_fetch_completed: 2,
  source_fetch_failed: 2,
  transcription_started: 3,
  transcription_completed: 3,
  transcription_failed: 3,
  clip_selection_started: 4,
  clip_selection_chunk_request_started: 4,
  clip_selection_chunk_request_failed: 4,
  clip_selection_chunk_response_error: 4,
  clip_selection_chunk_parse_failed: 4,
  clip_selection_chunk_complete: 4,
  clip_selection_chunks_complete: 4,
  clip_selection_ranking_started: 4,
  clip_selection_ranking_failed: 4,
  clip_selection_ranking_response_error: 4,
  clip_selection_ranking_parse_failed: 4,
  clip_selection_ranking_complete: 4,
  clip_selection_completed: 4,
  clip_selection_failed: 4,
  rendering_started: 5,
  rendering_completed: 5,
  rendering_failed: 5,
  clip_render_started: 5,
  clip_render_completed: 5,
  clip_render_failed: 5,
  clip_rerender_started: 5,
  clip_rerender_completed: 5,
  clip_rerender_failed: 5,
  stitch_started: 5,
  stitch_completed: 5,
  clip_finalize_started: 5,
  clip_finalize_completed: 5,
  clip_finalize_failed: 5,
  workflow_completed: 5,
  workflow_failed: 5
};

function formatTimestamp(): string {
  const now = new Date();
  return now.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${String(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = ((ms % 60000) / 1000).toFixed(0);
  return `${String(minutes)}m ${seconds}s`;
}

type LogEvent = Record<string, unknown>;

export type Logger = (event: LogEvent) => void;

function logValue(value: unknown, fallback = ""): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return fallback;
  }
}

export function createPrettyLogger(options?: {
  readonly showJson?: boolean;
  readonly trackDurations?: boolean;
}): Logger {
  const showJson = options?.showJson ?? false;
  const trackDurations = options?.trackDurations ?? true;
  const timers = new Map<string, number>();

  return (event: LogEvent) => {
    const eventName = logValue(event["event"], "log");
    const step = STEP_MAP[eventName];

    // Duration tracking — keyed specifically enough to survive parallel clip renders
    let durationStr = "";
    if (trackDurations) {
      const jobOrSermon = logValue(event["jobId"] ?? event["sermonId"], "unknown");
      let timerKey: string;
      if (event["clipIndex"] !== undefined) {
        timerKey = `${jobOrSermon}:clip:${String(event["clipIndex"])}`;
      } else if (event["clipId"] !== undefined) {
        timerKey = `${jobOrSermon}:rerender:${logValue(event["clipId"])}`;
      } else if (event["chunkIndex"] !== undefined) {
        timerKey = `${jobOrSermon}:chunk:${String(event["chunkIndex"])}`;
      } else {
        timerKey = `${jobOrSermon}:step:${String(step ?? eventName)}`;
      }

      if (eventName.endsWith("_started") || eventName === "sermon_submitted") {
        timers.set(timerKey, Date.now());
      } else if (
        eventName.endsWith("_completed") ||
        eventName.endsWith("_complete") ||
        eventName.endsWith("_failed")
      ) {
        const startTime = timers.get(timerKey);
        if (startTime) {
          durationStr = ` ${colors.dim}(${formatDuration(Date.now() - startTime)})${colors.reset}`;
          timers.delete(timerKey);
        }
      }
    }

    // Progress indicator
    let progressStr = "";
    if (step !== undefined) {
      const total = 5;
      const label = STEP_LABELS[step] ?? "?";
      const filled = "●".repeat(step);
      const empty = "○".repeat(total - step);
      progressStr = `${colors.cyan}[${filled}${empty}]${colors.reset} ${colors.bold}${label}${colors.reset} `;
    }

    const message = formatEventMessage(event, eventName);
    if (!message) return; // suppress noisy internal events

    let color: string = colors.reset;
    if (eventName.includes("failed") || eventName.includes("error")) {
      color = colors.red;
    } else if (
      eventName.includes("completed") ||
      eventName.endsWith("_complete") ||
      eventName === "workflow_completed"
    ) {
      color = colors.green;
    } else if (eventName.includes("started")) {
      color = colors.blue;
    } else if (eventName.includes("cache_hit")) {
      color = colors.magenta;
    }

    console.log(
      `${colors.dim}${formatTimestamp()}${colors.reset} ${progressStr}${color}${message}${colors.reset}${durationStr}`
    );

    if (showJson) {
      console.log(`${colors.gray}  ${JSON.stringify(event)}${colors.reset}`);
    }
  };
}

function formatEventMessage(event: LogEvent, eventName: string): string {
  const sermonId = event["sermonId"] ? logValue(event["sermonId"]).slice(-8) : null;
  const jobId = event["jobId"] ? logValue(event["jobId"]).slice(-8) : null;
  const id = jobId ?? sermonId ?? "";
  const idStr = id ? `[${id}] ` : "";

  switch (eventName) {
    case "api_started":
      return `API listening on port ${logValue(event["port"], "?")}`;

    case "sermon_submitted":
      return `${idStr}Job queued`;

    case "job_recovery_started":
      return `${idStr}Recovering interrupted job (was ${logValue(event["previousStatus"], "?")})`;

    // --- Download ---
    case "source_fetch_started":
      return `${idStr}Fetching source...`;

    case "youtube_media_download_started":
      return `${idStr}Downloading video ${logValue(event["videoId"], "?")}...`;

    case "youtube_media_cache_hit":
      return `${idStr}Video cached (${logValue(event["videoId"], "?")})`;

    case "youtube_media_download_completed":
      return `${idStr}Video downloaded (${logValue(event["videoId"], "?")})`;

    case "youtube_captions_download_started":
      return `${idStr}Downloading captions ${logValue(event["videoId"], "?")}...`;

    case "youtube_captions_cache_hit":
      return `${idStr}Captions cached (${logValue(event["videoId"], "?")})`;

    case "youtube_captions_download_completed":
      return `${idStr}Captions downloaded (${logValue(event["videoId"], "?")})`;

    case "source_fetch_completed":
      return `${idStr}Source ready (${logValue(event["videoId"], "?")})`;

    case "source_fetch_failed":
      return `${idStr}Source fetch failed: ${logValue(event["errorType"], "unknown")}`;

    // --- Transcription ---
    case "transcription_started":
      return `${idStr}Transcribing (${logValue(event["provider"], "?")}/${logValue(event["model"], "?")})...`;

    case "transcription_completed":
      return `${idStr}Transcript ready — ${logValue(event["segmentCount"], "?")} segments`;

    case "transcription_failed":
      return `${idStr}Transcription failed: ${logValue(event["errorType"], "unknown")}`;

    // --- Clip selection ---
    case "clip_selection_started": {
      // Two emitters: processing-service (has model) and openai-clip-selector (has chunkCount)
      if (event["chunkCount"] !== undefined) {
        return `${idStr}Analyzing ${logValue(event["chunkCount"], "?")} section(s), ${logValue(event["totalSegments"], "?")} segments...`;
      }
      return `${idStr}Selecting clips (${logValue(event["model"], "?")} ${logValue(event["promptVersion"], "?")})...`;
    }

    case "clip_selection_chunk_request_started": {
      const i = Number(event["chunkIndex"] ?? 0) + 1;
      const total = logValue(event["totalChunks"], "?");
      const start = Math.round(Number(event["chunkStartSeconds"] ?? 0) / 60);
      const end = Math.round(Number(event["chunkEndSeconds"] ?? 0) / 60);
      return `${idStr}  Section ${String(i)}/${total} (${String(start)}–${String(end)} min)...`;
    }

    case "clip_selection_chunk_request_failed": {
      const i = Number(event["chunkIndex"] ?? 0) + 1;
      return `${idStr}  Section ${String(i)} request failed: ${logValue(event["error"], "unknown")}`;
    }

    case "clip_selection_chunk_response_error": {
      const i = Number(event["chunkIndex"] ?? 0) + 1;
      return `${idStr}  Section ${String(i)} HTTP ${logValue(event["status"], "?")}`;
    }

    case "clip_selection_chunk_parse_failed": {
      const i = Number(event["chunkIndex"] ?? 0) + 1;
      return `${idStr}  Section ${String(i)} parse failed`;
    }

    case "clip_selection_chunk_complete": {
      const i = Number(event["chunkIndex"] ?? 0) + 1;
      return `${idStr}  Section ${String(i)}: ${logValue(event["clipsFound"], "?")} candidates`;
    }

    case "clip_selection_chunks_complete":
      return `${idStr}All sections done — ${logValue(event["totalCandidates"], "?")} candidates`;

    case "clip_selection_ranking_started":
      return `${idStr}Ranking ${logValue(event["candidateCount"], "?")} candidates → ${logValue(event["desiredCount"], "?")}...`;

    case "clip_selection_ranking_failed":
      return `${idStr}Ranking request failed: ${logValue(event["error"], "unknown")}`;

    case "clip_selection_ranking_response_error":
      return `${idStr}Ranking HTTP ${logValue(event["status"], "?")}`;

    case "clip_selection_ranking_parse_failed":
      return `${idStr}Ranking parse failed`;

    case "clip_selection_ranking_complete":
      return `${idStr}Ranked — ${logValue(event["selectedCount"], "?")} clips chosen`;

    case "clip_selection_completed":
      return `${idStr}${logValue(event["clipCount"], "?")} clips selected`;

    case "clip_selection_failed":
      return `${idStr}Clip selection failed: ${logValue(event["message"] ?? event["error"], "unknown")}`;

    // --- Rendering ---
    // ffmpeg-renderer fires rendering_started/completed per variant — suppress them, the
    // per-clip events from processing-service are the right level of granularity.
    case "rendering_started":
      if (event["clipCandidateId"]) return "";
      return `${idStr}Rendering ${logValue(event["clipCount"], "?")} clips...`;

    case "rendering_completed":
      if (event["clipCandidateId"]) return "";
      return `${idStr}All clips rendered`;

    case "rendering_failed": {
      const clipId = logValue(event["clipCandidateId"], "");
      const clipStr = clipId ? `[${clipId.slice(-8)}] ` : idStr;
      return `${clipStr}Render failed at ${logValue(event["step"], "?")} — ${logValue(event["errorType"] ?? event["message"], "unknown")}`;
    }

    case "clip_render_started": {
      const idx = logValue(event["clipIndex"], "?");
      const total = logValue(event["clipTotal"], "?");
      const title = logValue(event["clipTitle"], "?");
      const start = logValue(event["startSeconds"], "?");
      const end = logValue(event["endSeconds"], "?");
      return `${idStr}Clip ${idx}/${total}: "${title}" (${start}s–${end}s)`;
    }

    case "clip_render_completed": {
      const idx = logValue(event["clipIndex"], "?");
      const total = logValue(event["clipTotal"], "?");
      return `${idStr}Clip ${idx}/${total} done`;
    }

    case "clip_render_failed": {
      const idx = logValue(event["clipIndex"], "?");
      return `${idStr}Clip ${idx} failed: ${logValue(event["error"], "unknown")}`;
    }

    case "clip_rerender_started": {
      const start = logValue(event["startSeconds"], "?");
      const end = logValue(event["endSeconds"], "?");
      return `${idStr}Re-rendering clip (${start}s–${end}s)...`;
    }

    case "clip_rerender_completed":
      return `${idStr}Re-render complete`;

    case "clip_rerender_failed":
      return `${idStr}Re-render failed: ${logValue(event["error"], "unknown")}`;

    case "stitch_started":
      return `${idStr}Stitching ${logValue(event["segmentCount"], "?")} segment(s)...`;

    case "stitch_completed":
      return `${idStr}Stitched`;

    case "clip_finalize_started":
      return `${idStr}Finalizing clip (${logValue(event["blurPadSpanCount"], "0")} blur span(s))...`;

    case "clip_finalize_completed":
      return `${idStr}Clip finalized`;

    case "clip_finalize_failed":
      return `${idStr}Finalize failed: ${logValue(event["error"], "unknown")}`;

    case "workflow_completed":
      return `${idStr}Done — ${logValue(event["clipCount"], "?")} clips ready`;

    case "workflow_failed":
      return `${idStr}FAILED: ${logValue(event["message"], "unknown")}`;

    case "api_request_failed":
      return `API error: ${logValue(event["message"], "unknown")}`;

    default:
      return `${idStr}${eventName}`;
  }
}

export function createJsonLogger(): Logger {
  return (event: LogEvent) => {
    console.log(JSON.stringify({ ...event, timestamp: new Date().toISOString() }));
  };
}

export function createLogger(): Logger {
  const isPretty = process.env["LOG_FORMAT"] !== "json";
  const showJson = process.env["LOG_SHOW_JSON"] === "true";
  if (isPretty) {
    return createPrettyLogger({ showJson });
  }
  return createJsonLogger();
}
