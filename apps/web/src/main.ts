import { submissionAcceptedSchema, submitSermonSchema } from "@faithflips/core";
import type {
  GeneratedClip,
  ProcessingJob,
  ProcessingJobStatus,
  Sermon,
  SubmissionAccepted
} from "@faithflips/core";
import "./styles.css";

const apiUrl = import.meta.env["VITE_API_URL"] ?? "";
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

let state: ViewState = { status: "idle" };
let activeProgressStatus: ActiveProgressStatus | null = null;
let activeProgressStartedAt = Date.now();
let progressTimer: number | undefined;

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
      <div class="hero-entry${state.output ? " compact" : ""}">
        <header class="topbar">
          <div>
            <p class="eyebrow">FaithTok</p>
            <h1>Turn your sermon into viral clips</h1>
          </div>
        </header>

        <p class="hero-subtitle">Reach the next generation of Christians where they are</p>

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
            <label for="clip-count">How many clips to extract?
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
        </form>
        ${renderProgressBar()}
      </div>

      ${state.output ? renderReview(state.output) : ""}
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

  wireVideoPlayers();
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

  return `
    <section class="job-summary">
      <div>
        <span class="label">Sermon</span>
        <strong>${escapeHtml(output.sermon.title)}</strong>
      </div>
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
                return `
            <article class="clip-card" data-clip-index="${String(index)}">
              <div class="video-container" data-clip-id="${candidate.id}">
                <video class="clip-video" preload="auto">
                  <source src="${renderedClip.cropVideoUrl}" type="video/mp4">
                </video>
              </div>
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

  btn.disabled = true;
  btn.textContent = "Rendering...";
  try {
    const updated = await postJson(`/clips/${encodeURIComponent(clipId)}/rerender`, trim);
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
  triggerDownload(clip.renderedClip.cropVideoUrl, `${clipId}.mp4`);
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
      thumbnailUrl: rendered.thumbnailUrl + cacheBuster
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
// Video player wiring: click to play/pause
// ---------------------------------------------------------------------------

function wireVideoPlayers(): void {
  document.querySelectorAll<HTMLElement>(".clip-card").forEach((card) => {
    const video = card.querySelector<HTMLVideoElement>("video.clip-video");
    const container = card.querySelector<HTMLElement>(".video-container");
    if (!video || !container) return;

    container.addEventListener("click", () => {
      if (video.paused) void video.play().catch(() => undefined);
      else video.pause();
    });

    const syncPausedClass = (): void => {
      container.classList.toggle("paused", video.paused);
    };
    video.addEventListener("play", syncPausedClass);
    video.addEventListener("pause", syncPausedClass);
    syncPausedClass();
  });
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

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
