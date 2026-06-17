import { submitSermonSchema } from "@faithflips/core";
import type { GeneratedClip, ProcessingJob, Sermon } from "@faithflips/core";
import "./styles.css";

const apiUrl = import.meta.env["VITE_API_URL"] ?? "http://localhost:4000";
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

type SubmissionAccepted = {
  readonly sermonId: string;
  readonly jobId: string;
  readonly status: ProcessingJob["status"];
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

// Per-clip in-progress fill-mode edits, keyed by clip id. Contiguous segments cover
// the whole clip (clip-relative seconds); default mode is the close-up crop. Survives
// re-renders so edits aren't lost; cleared for a clip after its changes are applied.
const fillEdits = new Map<string, FillSegment[]>();

render();

function render(): void {
  appRoot.innerHTML = `
    <section class="shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">FaithFlips</p>
          <h1>Weekly church clips from a sermon URL</h1>
        </div>
        <span class="status-pill">${state.output?.job.status ?? "ready"}</span>
      </header>

      <form class="submit-panel" id="sermon-form">
        <label for="source-url">Sermon YouTube URL</label>
        <div class="url-row">
          <input
            id="source-url"
            name="sourceUrl"
            type="url"
            placeholder="https://www.youtube.com/watch?v=..."
            required
          />
          <button type="submit" ${state.status === "submitting" ? "disabled" : ""}>
            ${state.status === "idle" ? "Generate Clips" : "Processing"}
          </button>
        </div>
        ${state.error ? `<p class="error">${state.error}</p>` : ""}
      </form>

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

  wireFillTimelines();
}

function renderEmptyState(): string {
  return `
    <section class="empty-review">
      <div class="preview-frame"></div>
      <div>
        <h2>Review-ready clips will appear here</h2>
        <p>Submit a sermon URL to run ingestion, clip selection, rendering, and storage through the API workflow.</p>
      </div>
    </section>
  `;
}

function renderReview(output: WorkflowOutput): string {
  return `
    <section class="job-summary">
      <div>
        <span class="label">Sermon</span>
        <strong>${escapeHtml(output.sermon.title)}</strong>
      </div>
      <div>
        <span class="label">Job</span>
        <strong>${escapeHtml(output.job.id)}</strong>
      </div>
      <div>
        <span class="label">Clips</span>
        <strong>${String(output.clips.length)}</strong>
      </div>
    </section>

    <section class="clip-grid">
      ${
        output.clips.length === 0
          ? `<article class="clip-card"><div class="clip-body"><h2>${output.job.status === "failed" ? "Job failed" : "Processing clips"}</h2><p class="hook">${escapeHtml(output.job.failureReason ?? `Current status: ${output.job.status}`)}</p></div></article>`
          : output.clips
              .map(
                ({ candidate, renderedClip }, index) => `
            <article class="clip-card" data-clip-index="${index}">
              <div class="video-container" data-clip-id="${candidate.id}">
                <video class="clip-video crop" controls preload="auto">
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
                    <input type="number" class="timestamp-input" name="startSeconds"
                           value="${candidate.startSeconds}" step="0.1" min="0">
                  </label>
                  <label>
                    End
                    <input type="number" class="timestamp-input" name="endSeconds"
                           value="${candidate.endSeconds}" step="0.1" min="0">
                  </label>
                  <button type="button" class="rerender-btn" data-clip-id="${candidate.id}">
                    Re-render
                  </button>
                </div>
                <div class="clip-actions">
                  <button type="button" class="download-btn" data-clip-id="${candidate.id}">Download MP4</button>
                  <span class="confidence">${String(Math.round(candidate.confidence * 100))}% confidence</span>
                </div>
              </div>
            </article>
          `
              )
              .join("")
      }
    </section>
  `;
}

async function submitSermon(event: Event): Promise<void> {
  event.preventDefault();
  const form = event.currentTarget;
  if (!(form instanceof HTMLFormElement)) {
    return;
  }

  const formData = new FormData(form);
  const sourceUrlEntry = formData.get("sourceUrl");
  const sourceUrl = typeof sourceUrlEntry === "string" ? sourceUrlEntry : "";
  const parsed = submitSermonSchema.safeParse({ sourceUrl });
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

  const accepted = (await response.json()) as SubmissionAccepted;
  state = { status: "polling" };
  render();
  await pollJob(accepted.jobId);
}

async function pollJob(jobId: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const response = await fetch(`${apiUrl}/jobs/${encodeURIComponent(jobId)}`);
    if (response.ok) {
      const output = (await response.json()) as WorkflowOutput;
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
  const startSeconds = parseFloat(startInput.value);
  const endSeconds = parseFloat(endInput.value);
  if (isNaN(startSeconds) || isNaN(endSeconds) || startSeconds >= endSeconds) {
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
      ...(rendered.finalVideoUrl ? { finalVideoUrl: rendered.finalVideoUrl + cacheBuster } : {})
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
      <div class="fill-track">
        ${blocks}
        <div class="playhead" style="left:0%"></div>
        ${handles}
      </div>
      <div class="fill-controls">
        <button type="button" class="split-btn" data-clip-id="${candidate.id}">Split at playhead</button>
        <span class="fill-hint">Default close-up crop · click a block to flip to blur-pad · Download to export</span>
      </div>
    </div>
  `;
}

function wireFillTimelines(): void {
  document.querySelectorAll<HTMLElement>(".clip-card").forEach((card) => {
    const crop = card.querySelector<HTMLVideoElement>("video.crop");
    const blur = card.querySelector<HTMLVideoElement>("video.blur");
    const timeline = card.querySelector<HTMLElement>(".fill-timeline");
    if (!crop || !blur || !timeline) return;

    const duration = Number(timeline.dataset["duration"] ?? "0");

    // Instant preview: both full renders are loaded; we toggle which is visible per the
    // segment under the playhead. Both videos carry native controls, and whichever the user
    // touches drives the other so the visible (interactive) one is always in control. The
    // handlers are idempotent — each only acts when the target is out of sync — so the
    // paired play/pause/seek events can't feed back into an infinite loop. Crop stays the
    // audio master (blur is muted) and drives the preview refresh.
    let rafHandle = 0;
    const refresh = (): void => {
      updatePlayhead(card, crop.currentTime, duration);
      updatePreview(card);
    };
    // Both videos play in lockstep from the same start, so they stay aligned without
    // per-frame seeking (seeking a playing video forces a re-buffer / spinner). Drift is
    // only corrected on discrete user seeks, handled in link().
    const loop = (): void => {
      refresh();
      if (!crop.paused && !crop.ended) {
        rafHandle = requestAnimationFrame(loop);
      }
    };
    const link = (from: HTMLVideoElement, to: HTMLVideoElement): void => {
      from.addEventListener("play", () => {
        if (to.paused) void to.play().catch(() => undefined);
      });
      from.addEventListener("pause", () => {
        if (!to.paused) to.pause();
      });
      from.addEventListener("seeking", () => {
        if (Math.abs(to.currentTime - from.currentTime) > 0.05) to.currentTime = from.currentTime;
      });
      from.addEventListener("ratechange", () => {
        if (to.playbackRate !== from.playbackRate) to.playbackRate = from.playbackRate;
      });
      from.addEventListener("timeupdate", refresh);
      from.addEventListener("seeked", refresh);
      from.addEventListener("loadeddata", refresh);
    };
    link(crop, blur);
    link(blur, crop);

    // Crop is the audio master; keep the blur layer silent even if its controls are used.
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
    refresh();

    wireTimelineControls(card);
  });
}

function wireTimelineControls(card: HTMLElement): void {
  const timeline = card.querySelector<HTMLElement>(".fill-timeline");
  if (!timeline) return;
  const clipId = timeline.dataset["clipId"];
  if (!clipId) return;

  timeline.querySelectorAll<HTMLButtonElement>(".fill-segment").forEach((block) => {
    block.addEventListener("click", () => {
      toggleSegment(clipId, Number(block.dataset["segIndex"]));
      redrawTimeline(card, clipId);
    });
  });

  timeline.querySelectorAll<HTMLButtonElement>(".breakpoint").forEach((handle) => {
    handle.addEventListener("click", () => {
      removeBoundary(clipId, Number(handle.dataset["boundaryIndex"]));
      redrawTimeline(card, clipId);
    });
  });

  timeline.querySelector<HTMLButtonElement>(".split-btn")?.addEventListener("click", () => {
    const crop = card.querySelector<HTMLVideoElement>("video.crop");
    splitAt(clipId, crop ? crop.currentTime : 0);
    redrawTimeline(card, clipId);
  });
}

function redrawTimeline(card: HTMLElement, clipId: string): void {
  const candidate = findCandidate(clipId);
  const timeline = card.querySelector<HTMLElement>(".fill-timeline");
  if (!candidate || !timeline) return;
  timeline.outerHTML = fillTimelineHtml(candidate);
  wireTimelineControls(card);
  const crop = card.querySelector<HTMLVideoElement>("video.crop");
  if (crop) {
    updatePlayhead(card, crop.currentTime, clipDuration(candidate));
  }
  // Reflect the edit in the live preview at the current playhead position.
  updatePreview(card);
}

function updatePlayhead(card: HTMLElement, currentTime: number, duration: number): void {
  const playhead = card.querySelector<HTMLElement>(".playhead");
  if (!playhead || duration <= 0) return;
  const pct = clamp((currentTime / duration) * 100, 0, 100);
  playhead.style.left = `${pct.toFixed(4)}%`;
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

  const segments = fillEdits.get(clipId) ?? [];
  container.classList.toggle("show-blur", modeAt(segments, crop.currentTime) === "blur-pad");
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

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function withCurrentOutput(next: Omit<ViewState, "output">): ViewState {
  return state.output === undefined ? next : { ...next, output: state.output };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
}
