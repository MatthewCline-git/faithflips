/**
 * Human-readable logger with colors, timestamps, and progress tracking.
 */

// ANSI color codes
const colors = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  red: "\x1b[31m",
  gray: "\x1b[90m"
} as const;

// Workflow steps for progress tracking
const workflowSteps = [
  "sermon_submitted",
  "source_fetch_started",
  "source_fetch_completed",
  "transcription_started",
  "transcription_completed",
  "clip_selection_started",
  "clip_selection_completed",
  "rendering_started",
  "rendering_completed",
  "workflow_completed"
] as const;

type WorkflowStep = (typeof workflowSteps)[number];

function getStepNumber(event: string): { current: number; total: number } | null {
  const stepMap: Record<string, number> = {
    sermon_submitted: 1,
    source_fetch_started: 2,
    youtube_media_download_started: 2,
    youtube_media_download_completed: 2,
    youtube_captions_download_started: 2,
    youtube_captions_download_completed: 2,
    source_fetch_completed: 2,
    transcription_started: 3,
    transcription_completed: 3,
    clip_selection_started: 4,
    clip_selection_openai_request_started: 4,
    clip_selection_openai_response_received: 4,
    clip_selection_completed: 4,
    rendering_started: 5,
    clip_render_started: 5,
    clip_render_completed: 5,
    rendering_completed: 5,
    workflow_completed: 5
  };

  const step = stepMap[event];
  return step ? { current: step, total: 5 } : null;
}

function getStepLabel(step: number): string {
  const labels: Record<number, string> = {
    1: "Submit",
    2: "Download",
    3: "Transcribe",
    4: "Select Clips",
    5: "Render"
  };
  return labels[step] ?? "Unknown";
}

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
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = ((ms % 60000) / 1000).toFixed(0);
  return `${minutes}m ${seconds}s`;
}

type LogEvent = Record<string, unknown>;

export type Logger = (event: LogEvent) => void;

export function createPrettyLogger(options?: {
  readonly showJson?: boolean;
  readonly trackDurations?: boolean;
}): Logger {
  const showJson = options?.showJson ?? false;
  const trackDurations = options?.trackDurations ?? true;

  // Track step start times for duration calculation
  const stepStartTimes = new Map<string, number>();

  return (event: LogEvent) => {
    const eventName = String(event["event"] ?? "log");
    const timestamp = formatTimestamp();
    const stepInfo = getStepNumber(eventName);

    // Track durations
    let durationStr = "";
    if (trackDurations) {
      const jobId = String(event["jobId"] ?? event["sermonId"] ?? "unknown");
      const stepKey = `${jobId}:${stepInfo?.current ?? 0}`;

      if (eventName.endsWith("_started") || eventName === "sermon_submitted") {
        stepStartTimes.set(stepKey, Date.now());
      } else if (eventName.endsWith("_completed") || eventName.endsWith("_failed")) {
        const startTime = stepStartTimes.get(stepKey);
        if (startTime) {
          durationStr = ` ${colors.dim}(${formatDuration(Date.now() - startTime)})${colors.reset}`;
          stepStartTimes.delete(stepKey);
        }
      }
    }

    // Build progress indicator
    let progressStr = "";
    if (stepInfo) {
      const { current, total } = stepInfo;
      const label = getStepLabel(current);
      const filled = "●".repeat(current);
      const empty = "○".repeat(total - current);
      progressStr = `${colors.cyan}[${filled}${empty}]${colors.reset} ${colors.bold}${label}${colors.reset} `;
    }

    // Build the message based on event type
    const message = formatEventMessage(event, eventName);

    // Determine color based on event type
    let color: string = colors.reset;
    if (eventName.includes("failed") || eventName.includes("error")) {
      color = colors.red;
    } else if (eventName.includes("completed") || eventName === "workflow_completed") {
      color = colors.green;
    } else if (eventName.includes("started")) {
      color = colors.blue;
    } else if (eventName.includes("download")) {
      color = colors.magenta;
    }

    // Output the formatted log
    console.log(
      `${colors.dim}${timestamp}${colors.reset} ${progressStr}${color}${message}${colors.reset}${durationStr}`
    );

    // Optionally show raw JSON for debugging
    if (showJson) {
      console.log(`${colors.gray}  ${JSON.stringify(event)}${colors.reset}`);
    }
  };
}

function formatEventMessage(event: LogEvent, eventName: string): string {
  const sermonId = event["sermonId"] ? String(event["sermonId"]).slice(-8) : null;
  const jobId = event["jobId"] ? String(event["jobId"]).slice(-8) : null;
  const id = sermonId ?? jobId ?? "";
  const idStr = id ? `[${id}] ` : "";

  switch (eventName) {
    case "api_started":
      return `API started on port ${event["port"]}`;

    case "sermon_submitted":
      return `${idStr}New sermon submitted`;

    case "source_fetch_started":
      return `${idStr}Fetching YouTube source...`;

    case "youtube_media_download_started":
      return `${idStr}Downloading video (${event["videoId"]})...`;

    case "youtube_media_cache_hit":
      return `${idStr}Video cached (${event["videoId"]})`;

    case "youtube_media_download_completed":
      return `${idStr}Video downloaded`;

    case "youtube_captions_download_started":
      return `${idStr}Downloading captions (${event["videoId"]})...`;

    case "youtube_captions_cache_hit":
      return `${idStr}Captions cached (${event["videoId"]})`;

    case "youtube_captions_download_completed":
      return `${idStr}Captions downloaded`;

    case "source_fetch_completed":
      return `${idStr}Source fetched (${event["videoId"]})`;

    case "source_fetch_failed":
      return `${idStr}Source fetch failed: ${event["errorType"]}`;

    case "transcription_started":
      return `${idStr}Processing transcript (${event["provider"]}/${event["model"]})...`;

    case "transcription_completed": {
      const count = event["segmentCount"];
      return `${idStr}Transcript ready (${count} segments)`;
    }

    case "transcription_failed":
      return `${idStr}Transcription failed: ${event["errorType"]}`;

    case "clip_selection_started":
      return `${idStr}Selecting clips with ${event["model"]}...`;

    case "clip_selection_openai_request_started": {
      const chars = event["promptCharCount"];
      return `${idStr}Sending to OpenAI (${chars} chars)...`;
    }

    case "clip_selection_openai_response_received":
      return `${idStr}OpenAI responded (HTTP ${event["status"]})`;

    case "clip_selection_completed":
      return `${idStr}Selected ${event["clipCount"]} clips`;

    case "rendering_started": {
      if (event["clipCandidateId"]) {
        return `${idStr}ffmpeg: cutting ${event["clipCandidateId"]}`;
      }
      const clipCount = event["clipCount"];
      return `${idStr}Rendering ${clipCount ?? "?"} clips...`;
    }

    case "clip_render_started":
      return `${idStr}Rendering clip ${event["clipIndex"]}/${event["clipTotal"]}: ${event["clipTitle"]}`;

    case "clip_render_completed":
      return `${idStr}Clip ${event["clipIndex"]} rendered`;

    case "clip_rerender_started":
      return `${idStr}Re-rendering ${event["clipId"]} (${event["startSeconds"]}s - ${event["endSeconds"]}s)`;

    case "clip_rerender_completed":
      return `${idStr}Re-render complete`;

    case "clip_rerender_failed":
      return `${idStr}Re-render failed: ${event["error"]}`;

    case "rendering_completed": {
      if (event["clipCandidateId"]) {
        return `${idStr}ffmpeg: done ${event["clipCandidateId"]}`;
      }
      return `${idStr}All clips rendered`;
    }

    case "workflow_completed": {
      const count = event["clipCount"];
      return `${idStr}Done - ${count} clips ready`;
    }

    case "workflow_failed":
      return `${idStr}FAILED: ${event["message"]}`;

    case "api_request_failed":
      return `API error: ${event["message"]}`;

    default:
      // Generic format for unknown events
      return `${idStr}${eventName}`;
  }
}

/**
 * Create a logger that outputs JSON (for production/structured logging)
 */
export function createJsonLogger(): Logger {
  return (event: LogEvent) => {
    console.log(JSON.stringify({ ...event, timestamp: new Date().toISOString() }));
  };
}

/**
 * Create a logger based on environment
 */
export function createLogger(): Logger {
  const isPretty = process.env["LOG_FORMAT"] !== "json";
  const showJson = process.env["LOG_SHOW_JSON"] === "true";

  if (isPretty) {
    return createPrettyLogger({ showJson });
  }
  return createJsonLogger();
}
