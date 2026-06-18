import { submissionAcceptedSchema, submitSermonSchema } from "@faithflips/core";
import type {
  GeneratedClip,
  ProcessingJob,
  ProcessingJobStatus,
  Sermon,
  SubmissionAccepted
} from "@faithflips/core";
import "./styles.css";

const apiUrl = import.meta.env["VITE_API_URL"] ?? "http://localhost:4000";
const defaultSourceUrl = "https://www.youtube.com/watch?v=sCMVbmgrtZE";
const appRoot = getAppRoot();

function getAppRoot(): HTMLDivElement {
  const element = document.querySelector<HTMLDivElement>("#app");
  if (!element) {
    throw new Error("Missing app root");
  }
  return element;
}

type ViewState =
  | { readonly status: "idle"; readonly output?: WorkflowOutput; readonly error?: string }
  | {
      readonly status: "submitting";
      readonly output?: WorkflowOutput;
      readonly error?: string;
    }
  | {
      readonly status: "polling";
      readonly output?: WorkflowOutput;
      readonly error?: string;
    };

type WorkflowOutput = {
  readonly sermon: Sermon;
  readonly job: ProcessingJob;
  readonly clips: readonly GeneratedClip[];
};

type FillMode = "crop-fill" | "blur-pad";

type FillSegment = {
  startSeconds: number;
  endSeconds: number;
  mode: FillMode;
};

type ClipCandidate = GeneratedClip["candidate"];

let state: ViewState = { status: "idle" };
let activeProgressStatus: ActiveProgressStatus | null = null;
let activeProgressStartedAt = Date.now();
let progressTimer: number | undefined;

// Per-clip in-progress fill-mode edits, keyed by clip id. Contiguous segments cover
// the whole clip (clip-relative seconds); default mode is the close-up crop. Survives
// re-renders so edits aren't lost; cleared for a clip after its changes are applied.
const fillEdits = new Map<string, FillSegment[]>();

render();
void loadInitialRun();

async function loadInitialRun(): Promise<void> {
  const route = currentRunRoute();
  if (!route) return;

  const output = await fetchRun(route.youtubeContentId, route.runNumber);
  if (!output) return;

  state = {
    status:
      output.job.status === "completed" || output.job.status === "failed" ? "idle" : "polling",
    output
  };
  render();
  if (state.status === "polling") {
    await pollJob(output.job.id);
  }
}

function render(): void {
  const progressStatus = currentProgressStatus();
  if (progressStatus) {
    ensureProgressPhase(progressStatus);
  } else {
    stopProgressAnimation();
    activeProgressStatus = null;
  }

  appRoot.innerHTML = `
    <section class="shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">FaithFlips</p>
          <h1>Weekly church clips from a sermon URL</h1>
        </div>
      </header>

      <form class="submit-panel" id="sermon-form">
        <label for="source-url">Sermon YouTube URL</label>
        <div class="url-row">
          <input
            id="source-url"
            name="sourceUrl"
            type="url"
            placeholder="https://www.youtube.com/watch?v=..."
            value="${defaultSourceUrl}"
            required
          />
          <button type="submit" ${state.status === "submitting" ? "disabled" : ""}>
            ${state.status === "idle" ? "Generate Clips" : "Processing"}
          </button>
        </div>
        <div class="form-options">
          <label for="clip-count">Clips
            <input
              id="clip-count"
              name="clipCount"
              type="number"
              class="clip-count-input"
              min="1"
              max="12"
              value="6"
            />
          </label>
        </div>
        ${state.error ? `<p class="error">${state.error}</p>` : ""}
      </form>

      ${renderProgressBar()}

      ${state.output ? renderReview(state.output) : renderEmptyState()}
    </section>
  `;

  document.querySelector("#sermon-form")?.addEventListener("submit", (event) => {
    void submitSermon(event);
  });

  document.querySelectorAll(".rerender-btn").forEach((btn) => {
    btn.addEventListener("click", (event) => {
      void handleRerender(event);
    });
  });

  document.querySelectorAll(".download-btn").forEach((btn) => {
    btn.addEventListener("click", (event) => {
      void handleDownload(event);
    });
  });

  document.querySelectorAll(".regenerate-run-btn").forEach((btn) => {
    btn.addEventListener("click", (event) => {
      void handleRegenerateRun(event);
    });
  });

  wireFillTimelines();
  startProgressAnimation(progressStatus);
}

// ---------------------------------------------------------------------------
// Progress bar
// ---------------------------------------------------------------------------

type ProgressStatus = ProcessingJobStatus | "submitting";
type ActiveProgressStatus = Exclude<ProgressStatus, "completed" | "failed">;

type ProgressPhase = {
  readonly startPct: number;
  readonly endPct: number;
  readonly expectedMs: number;
  readonly caption: string;
};

const progressPhases: Record<ActiveProgressStatus, ProgressPhase> = {
  submitting: { startPct: 3, endPct: 8, expectedMs: 2_500, caption: "Submitting..." },
  queued: { startPct: 8, endPct: 15, expectedMs: 8_000, caption: "Queued..." },
  fetching_source: {
    startPct: 15,
    endPct: 32,
    expectedMs: 20_000,
    caption: "Downloading video..."
  },
  transcribing: {
    startPct: 32,
    endPct: 58,
    expectedMs: 45_000,
    caption: "Transcribing audio..."
  },
  selecting_clips: {
    startPct: 58,
    endPct: 76,
    expectedMs: 30_000,
    caption: "Finding viral moments..."
  },
  rendering_clips: {
    startPct: 76,
    endPct: 94,
    expectedMs: 60_000,
    caption: "Rendering clips..."
  }
};

function currentProgressStatus(): ActiveProgressStatus | null {
  if (state.status === "idle") return null;

  const jobStatus: ProgressStatus =
    state.status === "submitting" ? "submitting" : (state.output?.job.status ?? "queued");

  return jobStatus === "completed" || jobStatus === "failed" ? null : jobStatus;
}

function ensureProgressPhase(jobStatus: ActiveProgressStatus): void {
  if (activeProgressStatus === jobStatus) return;
  activeProgressStatus = jobStatus;
  activeProgressStartedAt = Date.now();
}

function progressPresentation(
  jobStatus: ActiveProgressStatus,
  now: number
): { pct: number; caption: string } {
  const phase = progressPhases[jobStatus];
  const elapsedMs = Math.max(0, now - activeProgressStartedAt);
  const linearProgress = Math.min(elapsedMs / phase.expectedMs, 0.98);
  const easedProgress = 1 - (1 - linearProgress) ** 3;
  const pct = phase.startPct + (phase.endPct - phase.startPct) * easedProgress;
  return { pct, caption: phase.caption };
}

function startProgressAnimation(jobStatus: ActiveProgressStatus | null): void {
  stopProgressAnimation();
  if (!jobStatus) return;

  const tick = (): void => {
    const fill = document.querySelector<HTMLElement>(".progress-fill");
    const pctLabel = document.querySelector<HTMLElement>(".progress-pct");
    if (!fill || !pctLabel || !activeProgressStatus) return;

    const { pct } = progressPresentation(activeProgressStatus, Date.now());
    fill.style.width = `${pct.toFixed(1)}%`;
    pctLabel.textContent = `${String(Math.floor(pct))}%`;
    progressTimer = window.setTimeout(tick, 250);
  };

  tick();
}

function stopProgressAnimation(): void {
  if (progressTimer !== undefined) {
    window.clearTimeout(progressTimer);
    progressTimer = undefined;
  }
}

function renderProgressBar(): string {
  const jobStatus = currentProgressStatus();
  if (!jobStatus) return "";

  const { pct, caption } = progressPresentation(jobStatus, Date.now());
  return `
    <div class="progress-panel">
      <div class="progress-track">
        <div class="progress-fill" style="width:${pct.toFixed(1)}%"></div>
      </div>
      <div class="progress-meta">
        <span class="progress-caption">${caption}</span>
        <span class="progress-pct">${String(Math.floor(pct))}%</span>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Empty state / review
// ---------------------------------------------------------------------------

function renderEmptyState(): string {
  return `
    <section class="empty-review">
      <div>
        <h2>Review-ready clips will appear here</h2>
        <p>Submit a sermon URL to run ingestion, clip selection, rendering, and storage through the API workflow.</p>
      </div>
    </section>
  `;
}

function renderReview(output: WorkflowOutput): string {
  const runRoute = runRouteFromJobId(output.job.id);
  const jobSummaryHtml =
    output.job.status === "completed"
      ? ""
      : `
      <div>
        <span class="label">Job</span>
        <strong>${escapeHtml(output.job.id)}</strong>
      </div>`;

  return `
    <section class="job-summary">
      <div>
        <span class="label">Sermon</span>
        <strong>${escapeHtml(output.sermon.title)}</strong>
      </div>
      ${jobSummaryHtml}
      <div>
        <span class="label">Clips</span>
        <strong>${String(output.clips.length)}</strong>
      </div>
      ${
        runRoute
          ? `<div class="summary-actions"><button type="button" class="regenerate-run-btn" data-youtube-content-id="${escapeHtml(runRoute.youtubeContentId)}">Re-generate clips</button></div>`
          : ""
      }
    </section>

    <section class="clip-grid">
      ${
        output.clips.length === 0
          ? `<article class="clip-card"><div class="clip-body"><h2>${output.job.status === "failed" ? "Job failed" : "Processing clips"}</h2><p class="hook">${escapeHtml(output.job.failureReason ?? `Current status: ${output.job.status}`)}</p></div></article>`
          : output.clips
              .map(({ candidate, renderedClip }, index) => {
                // Use the buffered preview for the crop video when available so small
                // timestamp adjustments can be previewed instantly without re-rendering.
                const previewStartSeconds =
                  renderedClip.previewStartSeconds ?? candidate.startSeconds;
                const previewUrlAttribute = renderedClip.previewUrl
                  ? ` data-preview-url="${escapeHtml(renderedClip.previewUrl)}"`
                  : "";

                return `
            <article class="clip-card" data-clip-index="${String(index)}">
              <div class="video-container"
                data-clip-id="${candidate.id}"
                data-buffer-before="0"
                data-clip-start="${String(candidate.startSeconds)}"
                data-clip-end="${String(candidate.endSeconds)}"
                data-crop-url="${escapeHtml(renderedClip.cropVideoUrl)}"
                data-preview-start="${String(previewStartSeconds)}"${previewUrlAttribute}>
                <video class="clip-video crop" controls preload="auto" data-active-url="${escapeHtml(renderedClip.cropVideoUrl)}">
                  <source src="${renderedClip.cropVideoUrl}" type="video/mp4">
                </video>
                <video class="clip-video blur" controls muted preload="auto">
                  <source src="${renderedClip.blurVideoUrl}" type="video/mp4">
                </video>
              </div>
              ${fillTimelineHtml(candidate)}
              <div class="clip-body">
                <h2>${escapeHtml(candidate.title)}</h2>
                <p class="hook">${escapeHtml(candidate.hook)}</p>
                <p class="caption">${escapeHtml(candidate.postCaption)}</p>
                <div class="timestamp-controls">
                  <label>
                    Start
                    <input type="text" class="timestamp-input" name="startSeconds"
                           value="${formatTime(candidate.startSeconds)}" inputmode="decimal">
                  </label>
                  <label>
                    End
                    <input type="text" class="timestamp-input" name="endSeconds"
                           value="${formatTime(candidate.endSeconds)}" inputmode="decimal">
                  </label>
                  <button type="button" class="rerender-btn" data-clip-id="${candidate.id}">
                    Re-render
                  </button>
                </div>
                <div class="clip-actions">
                  <button type="button" class="download-btn" data-clip-id="${candidate.id}">Download MP4</button>
                </div>
              </div>
            </article>
          `;
              })
              .join("")
      }
    </section>
  `;
}

// ---------------------------------------------------------------------------
// Form submission
// ---------------------------------------------------------------------------

async function submitSermon(event: Event): Promise<void> {
  event.preventDefault();
  const form = event.currentTarget;
  if (!(form instanceof HTMLFormElement)) {
    return;
  }

  const formData = new FormData(form);
  const sourceUrlEntry = formData.get("sourceUrl");
  const sourceUrl = typeof sourceUrlEntry === "string" ? sourceUrlEntry : "";
  const clipCountEntry = formData.get("clipCount");
  const clipCount =
    typeof clipCountEntry === "string"
      ? Math.max(1, Math.min(12, parseInt(clipCountEntry, 10)))
      : 6;
  const parsed = submitSermonSchema.safeParse({ sourceUrl, clipCount });
  if (!parsed.success) {
    state = withCurrentOutput({ status: "idle", error: "Enter a valid YouTube URL." });
    render();
    return;
  }

  state = withCurrentOutput({ status: "submitting" });
  render();

  const response = await fetch(`${apiUrl}/sermons`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(parsed.data)
  });

  if (!response.ok) {
    state = withCurrentOutput({ status: "idle", error: "The sermon could not be submitted." });
    render();
    return;
  }

  const accepted = parseSubmissionAccepted(await response.json());
  if (!accepted) {
    state = withCurrentOutput({
      status: "idle",
      error: "The API returned an outdated response. Restart the API server and try again."
    });
    render();
    return;
  }
  setRunRoute(accepted.youtubeContentId, accepted.runNumber);
  if (accepted.status !== "queued") {
    const cached = await fetchRun(accepted.youtubeContentId, accepted.runNumber);
    state = cached
      ? { status: "idle", output: cached }
      : { status: "idle", error: "The existing job could not be loaded." };
    render();
    return;
  }

  state = { status: "polling" };
  render();
  await pollJob(accepted.jobId);
}

async function pollJob(jobId: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const output = await fetchJob(jobId);
    if (output) {
      state = {
        status:
          output.job.status === "completed" || output.job.status === "failed" ? "idle" : "polling",
        output
      };
      render();
      if (output.job.status === "completed" || output.job.status === "failed") {
        return;
      }
    }
    await delay(2000);
  }

  state = withCurrentOutput({
    status: "idle",
    error: "The job is still processing. Refresh the page to check again."
  });
  render();
}

async function fetchJob(jobId: string): Promise<WorkflowOutput | undefined> {
  const response = await fetch(`${apiUrl}/jobs/${encodeURIComponent(jobId)}`);
  return response.ok ? ((await response.json()) as WorkflowOutput) : undefined;
}

async function fetchRun(
  youtubeContentId: string,
  runNumber: number
): Promise<WorkflowOutput | undefined> {
  const response = await fetch(
    `${apiUrl}/videos/${encodeURIComponent(youtubeContentId)}/runs/${String(runNumber)}`
  );
  return response.ok ? ((await response.json()) as WorkflowOutput) : undefined;
}

function parseSubmissionAccepted(value: unknown): SubmissionAccepted | undefined {
  const parsed = submissionAcceptedSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

async function handleRegenerateRun(event: Event): Promise<void> {
  const btn = event.currentTarget as HTMLButtonElement;
  const youtubeContentId = btn.dataset["youtubeContentId"];
  if (!youtubeContentId || !state.output) return;

  btn.disabled = true;
  btn.textContent = "Generating...";
  try {
    const response = await fetch(`${apiUrl}/videos/${encodeURIComponent(youtubeContentId)}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clipCount: state.output.sermon.clipCount })
    });
    if (!response.ok) {
      throw new Error("Run creation failed");
    }

    const accepted = parseSubmissionAccepted(await response.json());
    if (!accepted) {
      throw new Error("Run creation response was missing route fields");
    }
    setRunRoute(accepted.youtubeContentId, accepted.runNumber);
    state = { status: "polling" };
    render();
    await pollJob(accepted.jobId);
  } catch (err) {
    alert("Re-generation failed. Check console for details.");
    console.error(err);
    btn.disabled = false;
    btn.textContent = "Re-generate clips";
  }
}

async function handleRerender(event: Event): Promise<void> {
  const btn = event.currentTarget as HTMLButtonElement;
  const clipId = btn.dataset["clipId"];
  const card = btn.closest<HTMLElement>(".clip-card");
  if (!clipId || !card) return;

  const trim = readTrimInputs(card);
  if (!trim) {
    alert("Invalid timestamps");
    return;
  }

  // A trim re-renders both variants from source for the new window; the server resets
  // the fill plan, so drop local edits and re-init from the returned clip.
  btn.disabled = true;
  btn.textContent = "Rendering...";
  try {
    const updated = await postJson(`/clips/${encodeURIComponent(clipId)}/rerender`, trim);
    fillEdits.delete(clipId);
    replaceClip(clipId, updated);
  } catch (err) {
    alert("Re-render failed. Check console for details.");
    console.error(err);
    btn.disabled = false;
    btn.textContent = "Re-render";
  }
}

async function handleDownload(event: Event): Promise<void> {
  const btn = event.currentTarget as HTMLButtonElement;
  const clipId = btn.dataset["clipId"];
  if (!clipId) return;
  const clip = state.output?.clips.find((c) => c.candidate.id === clipId);
  if (!clip) return;

  const segments = fillEdits.get(clipId) ?? getSegments(clip.candidate);
  const hasBlur = segments.some((segment) => segment.mode === "blur-pad");
  const hasCrop = segments.some((segment) => segment.mode === "crop-fill");

  // Pure plans need no stitch — download the matching pre-rendered file directly.
  if (!hasBlur) {
    triggerDownload(clip.renderedClip.cropVideoUrl, `${clipId}.mp4`);
    return;
  }
  if (!hasCrop) {
    triggerDownload(clip.renderedClip.blurVideoUrl, `${clipId}.mp4`);
    return;
  }

  btn.disabled = true;
  btn.textContent = "Stitching...";
  try {
    const blurPadSpans = segmentsToSpans(segments);
    const updated = await postJson(`/clips/${encodeURIComponent(clipId)}/finalize`, {
      blurPadSpans
    });
    replaceClip(clipId, updated);
    if (updated.renderedClip.finalVideoUrl) {
      triggerDownload(updated.renderedClip.finalVideoUrl, `${clipId}.mp4`);
    }
  } catch (err) {
    alert("Stitch failed. Check console for details.");
    console.error(err);
  } finally {
    btn.disabled = false;
    btn.textContent = "Download MP4";
  }
}

function readTrimInputs(
  card: HTMLElement
): { startSeconds: number; endSeconds: number } | undefined {
  const startInput = card.querySelector<HTMLInputElement>('input[name="startSeconds"]');
  const endInput = card.querySelector<HTMLInputElement>('input[name="endSeconds"]');
  if (!startInput || !endInput) return undefined;
  const startSeconds = parseTimestampInput(startInput.value);
  const endSeconds = parseTimestampInput(endInput.value);
  if (startSeconds === undefined || endSeconds === undefined || startSeconds >= endSeconds) {
    return undefined;
  }
  return { startSeconds, endSeconds };
}

async function postJson(path: string, body: unknown): Promise<GeneratedClip> {
  const response = await fetch(`${apiUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(`Request failed: ${path}`);
  }
  return (await response.json()) as GeneratedClip;
}

// Swap an updated clip into view state with cache-busted media URLs and re-render.
function replaceClip(clipId: string, updated: GeneratedClip): void {
  if (!state.output) return;
  const clipIndex = state.output.clips.findIndex((c) => c.candidate.id === clipId);
  if (clipIndex < 0) return;

  const cacheBuster = `?v=${String(Date.now())}`;
  const rendered = updated.renderedClip;
  const newClips = [...state.output.clips];
  newClips[clipIndex] = {
    ...updated,
    renderedClip: {
      ...rendered,
      cropVideoUrl: rendered.cropVideoUrl + cacheBuster,
      blurVideoUrl: rendered.blurVideoUrl + cacheBuster,
      thumbnailUrl: rendered.thumbnailUrl + cacheBuster,
      ...(rendered.finalVideoUrl ? { finalVideoUrl: rendered.finalVideoUrl + cacheBuster } : {}),
      ...(rendered.previewUrl ? { previewUrl: rendered.previewUrl + cacheBuster } : {})
    }
  };
  state = { ...state, output: { ...state.output, clips: newClips } };
  render();
}

function triggerDownload(url: string, filename: string): void {
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

// ---------------------------------------------------------------------------
// Fill-mode timeline
// ---------------------------------------------------------------------------

type FillSpan = { startSeconds: number; endSeconds: number };

function clipDuration(candidate: ClipCandidate): number {
  return Math.max(0, candidate.endSeconds - candidate.startSeconds);
}

function getSegments(candidate: ClipCandidate): FillSegment[] {
  const existing = fillEdits.get(candidate.id);
  if (existing) {
    return existing;
  }
  const segments = segmentsFromSpans(candidate.blurPadSpans, clipDuration(candidate));
  fillEdits.set(candidate.id, segments);
  return segments;
}

function segmentsFromSpans(spans: readonly FillSpan[], duration: number): FillSegment[] {
  const segments: FillSegment[] = [];
  let cursor = 0;
  for (const span of spans) {
    const start = clamp(span.startSeconds, 0, duration);
    const end = clamp(span.endSeconds, 0, duration);
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

function mergeAdjacent(segments: FillSegment[]): FillSegment[] {
  const merged: FillSegment[] = [];
  for (const segment of segments) {
    const last = merged[merged.length - 1];
    if (last && last.mode === segment.mode) {
      last.endSeconds = segment.endSeconds;
    } else {
      merged.push({ ...segment });
    }
  }
  return merged;
}

function segmentsToSpans(segments: readonly FillSegment[]): FillSpan[] {
  return segments
    .filter((segment) => segment.mode === "blur-pad")
    .map((segment) => ({
      startSeconds: round(segment.startSeconds),
      endSeconds: round(segment.endSeconds)
    }));
}

function fillTimelineHtml(candidate: ClipCandidate): string {
  const duration = clipDuration(candidate);
  const segments = getSegments(candidate);

  const blocks = segments
    .map((segment, index) => {
      const widthPct =
        duration > 0 ? ((segment.endSeconds - segment.startSeconds) / duration) * 100 : 0;
      const label = segment.mode === "blur-pad" ? "blur-pad" : "crop";
      const title = `${formatTime(segment.startSeconds)}–${formatTime(segment.endSeconds)} · click to flip`;
      return `<button type="button" class="fill-segment ${segment.mode === "blur-pad" ? "blur" : "crop"}" data-seg-index="${String(index)}" style="width:${widthPct.toFixed(4)}%" title="${title}">${label}</button>`;
    })
    .join("");

  const handles = segments
    .slice(1)
    .map((segment, index) => {
      const leftPct = duration > 0 ? (segment.startSeconds / duration) * 100 : 0;
      return `<button type="button" class="breakpoint" data-boundary-index="${String(index + 1)}" style="left:${leftPct.toFixed(4)}%" title="Remove breakpoint">×</button>`;
    })
    .join("");

  return `
    <div class="fill-timeline" data-clip-id="${candidate.id}" data-duration="${String(duration)}">
      <div class="fill-track-shell">
        <div class="fill-track">
          ${blocks}
          <div class="playhead" style="left:0%"></div>
          ${handles}
        </div>
        <button type="button" class="playhead-handle" style="left:0%" title="Drag playhead"></button>
      </div>
      <div class="fill-controls">
        <button type="button" class="split-btn" data-clip-id="${candidate.id}">Split at playhead</button>
        <span class="fill-hint">Click to flip fill mode · Drag to seek · Download to export</span>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Fill-timeline wiring: video sync, buffered preview, draggable playhead
// ---------------------------------------------------------------------------

function wireFillTimelines(): void {
  document.querySelectorAll<HTMLElement>(".clip-card").forEach((card) => {
    const crop = card.querySelector<HTMLVideoElement>("video.crop");
    const blur = card.querySelector<HTMLVideoElement>("video.blur");
    const timeline = card.querySelector<HTMLElement>(".fill-timeline");
    const container = card.querySelector<HTMLElement>(".video-container");
    if (!crop || !blur || !timeline || !container) return;

    const duration = Number(timeline.dataset["duration"] ?? "0");
    const clipStart = Number(container.dataset["clipStart"] ?? "0");
    const clipEnd = Number(container.dataset["clipEnd"] ?? "0");
    const previewStart = Number(container.dataset["previewStart"] ?? String(clipStart));
    const cropUrl = container.dataset["cropUrl"];
    const previewUrl = container.dataset["previewUrl"];
    const getBufferBefore = (): number => Number(container.dataset["bufferBefore"] ?? "0");
    const seekToSermonTime = (sermonTime: number): void => {
      const needsPreview = sermonTime < clipStart || sermonTime > clipEnd;
      const targetUrl = needsPreview && previewUrl ? previewUrl : cropUrl;
      const targetBufferBefore =
        needsPreview && previewUrl ? Math.max(0, clipStart - previewStart) : 0;
      const targetCurrentTime =
        targetBufferBefore > 0
          ? Math.max(0, sermonTime - previewStart)
          : Math.max(0, sermonTime - clipStart);

      if (targetUrl && crop.dataset["activeUrl"] !== targetUrl) {
        container.dataset["bufferBefore"] = String(targetBufferBefore);
        crop.dataset["activeUrl"] = targetUrl;
        crop.src = targetUrl;
        crop.addEventListener(
          "loadedmetadata",
          () => {
            crop.currentTime = targetCurrentTime;
          },
          { once: true }
        );
        crop.load();
        return;
      }

      container.dataset["bufferBefore"] = String(targetBufferBefore);
      crop.currentTime = targetCurrentTime;
    };

    let rafHandle = 0;
    const refresh = (): void => {
      const bufferBefore = getBufferBefore();
      const clipRelTime = Math.max(0, crop.currentTime - bufferBefore);
      const trim = readTrimInputs(card);
      const selectedEnd = trim?.endSeconds ?? clipEnd;
      const selectedDuration = Math.max(0, selectedEnd - clipStart);
      if (selectedDuration > 0 && clipRelTime > selectedDuration + 0.05) {
        crop.currentTime = bufferBefore + selectedDuration;
        crop.pause();
        return;
      }
      updatePlayhead(card, clipRelTime, duration);
      updatePreview(card);
    };
    // Both videos play from a shared start time; we only correct drift on explicit seeks.
    const loop = (): void => {
      refresh();
      if (!crop.paused && !crop.ended) {
        rafHandle = requestAnimationFrame(loop);
      }
    };

    // crop → blur sync with buffer offset compensation
    crop.addEventListener("play", () => {
      if (blur.paused) void blur.play().catch(() => undefined);
    });
    crop.addEventListener("pause", () => {
      if (!blur.paused) blur.pause();
    });
    crop.addEventListener("seeking", () => {
      const bufferBefore = getBufferBefore();
      const blurTarget = Math.max(0, crop.currentTime - bufferBefore);
      if (Math.abs(blur.currentTime - blurTarget) > 0.05) blur.currentTime = blurTarget;
    });
    crop.addEventListener("ratechange", () => {
      if (blur.playbackRate !== crop.playbackRate) blur.playbackRate = crop.playbackRate;
    });
    crop.addEventListener("timeupdate", refresh);
    crop.addEventListener("seeked", refresh);
    crop.addEventListener("loadeddata", refresh);

    // blur → crop sync with buffer offset compensation
    blur.addEventListener("play", () => {
      if (crop.paused) void crop.play().catch(() => undefined);
    });
    blur.addEventListener("pause", () => {
      if (!crop.paused) crop.pause();
    });
    blur.addEventListener("seeking", () => {
      const bufferBefore = getBufferBefore();
      const cropTarget = blur.currentTime + bufferBefore;
      if (Math.abs(crop.currentTime - cropTarget) > 0.05) crop.currentTime = cropTarget;
    });
    blur.addEventListener("ratechange", () => {
      if (crop.playbackRate !== blur.playbackRate) crop.playbackRate = blur.playbackRate;
    });
    blur.addEventListener("timeupdate", refresh);
    blur.addEventListener("seeked", refresh);
    blur.addEventListener("loadeddata", refresh);

    // Crop is the audio master; keep the blur layer silent.
    blur.addEventListener("volumechange", () => {
      if (!blur.muted) blur.muted = true;
    });

    crop.addEventListener("play", () => {
      cancelAnimationFrame(rafHandle);
      rafHandle = requestAnimationFrame(loop);
    });
    crop.addEventListener("pause", () => {
      cancelAnimationFrame(rafHandle);
    });

    // Quick-seek when timestamp inputs change — if the new time is within the buffered
    // preview window, show it instantly without waiting for a re-render.
    const startInput = card.querySelector<HTMLInputElement>('input[name="startSeconds"]');
    const endInput = card.querySelector<HTMLInputElement>('input[name="endSeconds"]');
    startInput?.addEventListener("input", () => {
      const newStart = parseTimestampInput(startInput.value);
      if (newStart !== undefined) {
        seekToSermonTime(newStart);
      }
    });
    endInput?.addEventListener("input", () => {
      const newEnd = parseTimestampInput(endInput.value);
      if (newEnd !== undefined) {
        seekToSermonTime(newEnd);
      }
    });

    refresh();
    wireTimelineControls(card);
  });
}

function wireTimelineControls(card: HTMLElement): void {
  const timeline = card.querySelector<HTMLElement>(".fill-timeline");
  if (!timeline) return;
  const clipId = timeline.dataset["clipId"];
  if (!clipId) return;
  const duration = Number(timeline.dataset["duration"] ?? "0");

  // Segment click-to-toggle for keyboard accessibility (mouse handled via pointer capture below)
  timeline.querySelectorAll<HTMLButtonElement>(".fill-segment").forEach((block) => {
    block.addEventListener("click", () => {
      toggleSegment(clipId, Number(block.dataset["segIndex"]));
      redrawTimeline(card, clipId);
    });
  });

  // Breakpoint removal
  timeline.querySelectorAll<HTMLButtonElement>(".breakpoint").forEach((handle) => {
    handle.addEventListener("click", () => {
      removeBoundary(clipId, Number(handle.dataset["boundaryIndex"]));
      redrawTimeline(card, clipId);
    });
  });

  // Split at playhead (use clip-relative time, not raw crop.currentTime)
  timeline.querySelector<HTMLButtonElement>(".split-btn")?.addEventListener("click", () => {
    const crop = card.querySelector<HTMLVideoElement>("video.crop");
    const container = card.querySelector<HTMLElement>(".video-container");
    const bufferBefore = Number(container?.dataset["bufferBefore"] ?? "0");
    splitAt(clipId, crop ? Math.max(0, crop.currentTime - bufferBefore) : 0);
    redrawTimeline(card, clipId);
  });

  // Drag-to-seek on the fill track. Pointer capture routes all pointer events to the
  // track after pointerdown so dragging outside the track still updates the playhead.
  // Short movements (≤4px) are treated as clicks and toggle the segment under the cursor
  // (matching what the keyboard click handlers above do).
  const track = timeline.querySelector<HTMLElement>(".fill-track");
  const playheadHandle = timeline.querySelector<HTMLButtonElement>(".playhead-handle");
  const crop = card.querySelector<HTMLVideoElement>("video.crop");
  const container = card.querySelector<HTMLElement>(".video-container");
  if (!track) return;

  let dragStartX = 0;
  let hasMoved = false;

  const seekFromPointer = (clientX: number): void => {
    const rect = track.getBoundingClientRect();
    const pct = clamp((clientX - rect.left) / rect.width, 0, 1);
    const clipRelativeTime = pct * duration;
    const bufferBefore = Number(container?.dataset["bufferBefore"] ?? "0");

    if (crop) crop.currentTime = bufferBefore + clipRelativeTime;
    updatePlayhead(card, clipRelativeTime, duration);
  };

  track.addEventListener("pointerdown", (e) => {
    // Let breakpoint buttons handle their own pointer events.
    if ((e.target as HTMLElement).classList.contains("breakpoint")) return;
    dragStartX = e.clientX;
    hasMoved = false;
    track.setPointerCapture(e.pointerId);
  });

  track.addEventListener("pointermove", (e) => {
    if (!track.hasPointerCapture(e.pointerId)) return;
    if (Math.abs(e.clientX - dragStartX) > 4) hasMoved = true;
    if (!hasMoved) return;

    track.style.cursor = "grabbing";
    seekFromPointer(e.clientX);
  });

  track.addEventListener("pointerup", (e) => {
    if (!track.hasPointerCapture(e.pointerId)) return;
    track.releasePointerCapture(e.pointerId);
    track.style.cursor = "";

    if (!hasMoved) {
      // Short click on track that didn't land on a segment button: toggle by position.
      // (Clicks on segment buttons are handled by the button's own click handler above.)
      const rect = track.getBoundingClientRect();
      const pct = clamp((e.clientX - rect.left) / rect.width, 0, 1);
      const clickTime = pct * duration;
      const segments = fillEdits.get(clipId) ?? [];
      const segIndex = segments.findIndex(
        (seg) => clickTime >= seg.startSeconds && clickTime < seg.endSeconds
      );
      if (segIndex >= 0) {
        toggleSegment(clipId, segIndex);
        redrawTimeline(card, clipId);
      }
    }
    hasMoved = false;
  });

  playheadHandle?.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    dragStartX = e.clientX;
    hasMoved = true;
    playheadHandle.setPointerCapture(e.pointerId);
  });

  playheadHandle?.addEventListener("pointermove", (e) => {
    if (!playheadHandle.hasPointerCapture(e.pointerId)) return;
    seekFromPointer(e.clientX);
  });

  playheadHandle?.addEventListener("pointerup", (e) => {
    if (!playheadHandle.hasPointerCapture(e.pointerId)) return;
    playheadHandle.releasePointerCapture(e.pointerId);
    hasMoved = false;
  });
}

function redrawTimeline(card: HTMLElement, clipId: string): void {
  const candidate = findCandidate(clipId);
  const timeline = card.querySelector<HTMLElement>(".fill-timeline");
  if (!candidate || !timeline) return;
  timeline.outerHTML = fillTimelineHtml(candidate);
  wireTimelineControls(card);
  const crop = card.querySelector<HTMLVideoElement>("video.crop");
  const container = card.querySelector<HTMLElement>(".video-container");
  const bufferBefore = Number(container?.dataset["bufferBefore"] ?? "0");
  if (crop) {
    updatePlayhead(card, Math.max(0, crop.currentTime - bufferBefore), clipDuration(candidate));
  }
  updatePreview(card);
}

function updatePlayhead(card: HTMLElement, clipRelativeTime: number, duration: number): void {
  const playhead = card.querySelector<HTMLElement>(".playhead");
  const playheadHandle = card.querySelector<HTMLElement>(".playhead-handle");
  if (!playhead || !playheadHandle || duration <= 0) return;
  const pct = clamp((clipRelativeTime / duration) * 100, 0, 100);
  playhead.style.left = `${pct.toFixed(4)}%`;
  playheadHandle.style.left = `${pct.toFixed(4)}%`;
}

// ---------------------------------------------------------------------------
// Two-video preview: show crop or blur per the segment under the playhead
// ---------------------------------------------------------------------------

function modeAt(segments: readonly FillSegment[], time: number): FillMode {
  for (const segment of segments) {
    if (time >= segment.startSeconds && time < segment.endSeconds) {
      return segment.mode;
    }
  }
  return "crop-fill";
}

function updatePreview(card: HTMLElement): void {
  const container = card.querySelector<HTMLElement>(".video-container");
  const crop = card.querySelector<HTMLVideoElement>("video.crop");
  const clipId = container?.dataset["clipId"];
  if (!container || !crop || !clipId) return;

  const bufferBefore = Number(container.dataset["bufferBefore"] ?? "0");
  const clipRelativeTime = Math.max(0, crop.currentTime - bufferBefore);
  const segments = fillEdits.get(clipId) ?? [];
  container.classList.toggle("show-blur", modeAt(segments, clipRelativeTime) === "blur-pad");
}

function toggleSegment(clipId: string, index: number): void {
  const segments = fillEdits.get(clipId);
  if (!segments || !segments[index]) return;
  const flipped: FillMode = segments[index].mode === "crop-fill" ? "blur-pad" : "crop-fill";
  segments[index] = { ...segments[index], mode: flipped };
  fillEdits.set(clipId, mergeAdjacent(segments));
}

function splitAt(clipId: string, time: number): void {
  const segments = fillEdits.get(clipId);
  if (!segments) return;
  const out: FillSegment[] = [];
  for (const segment of segments) {
    if (time > segment.startSeconds + 0.05 && time < segment.endSeconds - 0.05) {
      out.push({ startSeconds: segment.startSeconds, endSeconds: time, mode: segment.mode });
      out.push({ startSeconds: time, endSeconds: segment.endSeconds, mode: segment.mode });
    } else {
      out.push({ ...segment });
    }
  }
  fillEdits.set(clipId, out);
}

function removeBoundary(clipId: string, boundaryIndex: number): void {
  const segments = fillEdits.get(clipId);
  if (!segments || boundaryIndex <= 0 || boundaryIndex >= segments.length) return;
  const left = segments[boundaryIndex - 1];
  const right = segments[boundaryIndex];
  if (!left || !right) return;
  // Merge into the left segment's mode (adjacent segments always differ in mode).
  const merged: FillSegment = {
    startSeconds: left.startSeconds,
    endSeconds: right.endSeconds,
    mode: left.mode
  };
  const next = [
    ...segments.slice(0, boundaryIndex - 1),
    merged,
    ...segments.slice(boundaryIndex + 1)
  ];
  fillEdits.set(clipId, mergeAdjacent(next));
}

function findCandidate(clipId: string): ClipCandidate | undefined {
  return state.output?.clips.find((clip) => clip.candidate.id === clipId)?.candidate;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function formatTime(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${String(minutes)}:${seconds.toString().padStart(2, "0")}`;
}

function parseTimestampInput(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const parts = trimmed.split(":");
  if (parts.length === 1) {
    const seconds = Number(parts[0]);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
  }

  if (parts.length !== 2) return undefined;

  const minutes = Number(parts[0]);
  const seconds = Number(parts[1]);
  if (
    !Number.isInteger(minutes) ||
    !Number.isFinite(seconds) ||
    minutes < 0 ||
    seconds < 0 ||
    seconds >= 60
  ) {
    return undefined;
  }

  return minutes * 60 + seconds;
}

function currentRunRoute(): {
  readonly youtubeContentId: string;
  readonly runNumber: number;
} | null {
  const params = new URLSearchParams(window.location.search);
  const youtubeContentId = params.get("video");
  const runRaw = params.get("run");
  const runNumber = runRaw ? Number(runRaw) : NaN;
  if (!youtubeContentId || !Number.isInteger(runNumber) || runNumber <= 0) {
    return null;
  }
  return { youtubeContentId, runNumber };
}

function setRunRoute(youtubeContentId: string, runNumber: number): void {
  if (!youtubeContentId || !Number.isInteger(runNumber) || runNumber <= 0) {
    return;
  }
  const url = new URL(window.location.href);
  url.searchParams.set("video", youtubeContentId);
  url.searchParams.set("run", String(runNumber));
  window.history.replaceState(null, "", url);
}

function runRouteFromJobId(
  jobId: string
): { readonly youtubeContentId: string; readonly runNumber: number } | null {
  const match = /^job_(.+)_run_(\d+)$/.exec(jobId);
  if (!match) return null;
  const runNumber = Number(match[2]);
  return match[1] && Number.isInteger(runNumber) && runNumber > 0
    ? { youtubeContentId: match[1], runNumber }
    : null;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function withCurrentOutput(next: Omit<ViewState, "output">): ViewState {
  return state.output === undefined ? next : { ...next, output: state.output };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
}
