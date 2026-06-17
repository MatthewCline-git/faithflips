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

let state: ViewState = { status: "idle" };

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
              <div class="video-container">
                <video controls preload="metadata">
                  <source src="${renderedClip.videoUrl}" type="video/mp4">
                </video>
              </div>
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
                  <a href="${renderedClip.videoUrl}" download class="download-link">Download MP4</a>
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
  const card = btn.closest(".clip-card") as HTMLElement;
  if (!clipId || !card || !state.output) return;

  const startInput = card.querySelector('input[name="startSeconds"]') as HTMLInputElement;
  const endInput = card.querySelector('input[name="endSeconds"]') as HTMLInputElement;
  const startSeconds = parseFloat(startInput.value);
  const endSeconds = parseFloat(endInput.value);

  if (isNaN(startSeconds) || isNaN(endSeconds) || startSeconds >= endSeconds) {
    alert("Invalid timestamps");
    return;
  }

  btn.disabled = true;
  btn.textContent = "Rendering...";

  try {
    const response = await fetch(`${apiUrl}/clips/${encodeURIComponent(clipId)}/rerender`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ startSeconds, endSeconds })
    });

    if (!response.ok) {
      throw new Error("Re-render failed");
    }

    const updated = (await response.json()) as { candidate: GeneratedClip["candidate"]; renderedClip: GeneratedClip["renderedClip"] };

    if (state.output) {
      const clipIndex = state.output.clips.findIndex((c) => c.candidate.id === clipId);
      if (clipIndex >= 0) {
        const newClips = [...state.output.clips];
        const cacheBuster = `?v=${Date.now()}`;
        newClips[clipIndex] = {
          ...updated,
          renderedClip: {
            ...updated.renderedClip,
            videoUrl: updated.renderedClip.videoUrl + cacheBuster,
            thumbnailUrl: updated.renderedClip.thumbnailUrl + cacheBuster
          }
        };
        state = {
          ...state,
          output: { ...state.output, clips: newClips }
        };
        render();
      }
    }
  } catch (err) {
    alert("Re-render failed. Check console for details.");
    console.error(err);
    btn.disabled = false;
    btn.textContent = "Re-render";
  }
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
