# FaithFlips Implementation Plan

## Product Direction

FaithFlips turns a church sermon into ready-to-post social media clips. The buyer should experience the product as "weekly church social content done for you," not as a generic AI clipping tool.

The MVP should make the core promise concrete:

1. A church submits a sermon YouTube URL.
2. FaithFlips finds the best short moments.
3. FaithFlips generates vertical clips with captions.
4. FaithFlips writes post captions and hashtags.
5. The church reviews and downloads the finished assets.

The primary product question is not whether the system can generate clips. It is whether the returned clips are good enough that a church staff member would post them with little or no editing.

## MVP Scope

The first usable MVP should support:

- YouTube URL submission.
- A sermon processing job with visible statuses.
- Transcript-based clip recommendation.
- Structured clip categories:
  - invitation
  - encouragement
  - teaching
  - quote
  - recap
- Generated clip title, rationale, start time, end time, post caption, and hashtags.
- Vertical short-form output target, initially designed around Instagram Reels, TikTok, and YouTube Shorts.
- A simple review page showing generated clips and downloadable outputs.
- Versioned prompts and eval fixtures from the beginning.

The first implementation may use deterministic stubs for model output and rendering while the product loop is built. Stubs should live behind the same interfaces that real integrations will later implement.

## Non-Goals For The MVP

Do not build these until the core loop is proven:

- Direct social posting.
- Multi-step approval workflows.
- Advanced analytics.
- Church website integrations.
- Full CRM features.
- Team roles beyond the minimum needed for testing.
- Per-platform scheduling.
- Complex brand kits.
- Automated face tracking if a simple crop is sufficient for initial testing.
- MP4 uploads, unless YouTube ingestion becomes blocked.

## Default Technical Stack

Follow `AGENTS.md`.

- TypeScript for application code.
- Strict TypeScript settings.
- Zod for boundary validation.
- Vitest for tests.
- ESLint and Prettier.
- Typed database tooling such as Prisma or Drizzle when persistence is added.
- Result-style returns for expected domain and integration failures.
- Factory functions for dependency injection.

## Proposed Repository Shape

This can start as a monorepo:

```text
apps/
  api/
    src/
  web/
    src/
packages/
  core/
    src/
  prompts/
  evals/
    fixtures/
    src/
docs/
  implementation-plan.md
```

Initial responsibilities:

- `apps/api`: HTTP API, job routes, workflow orchestration entrypoints.
- `apps/web`: simple user interface for submitting sermons and reviewing results.
- `packages/core`: shared domain types, schemas, workflow contracts, errors.
- `packages/prompts`: versioned prompts and prompt metadata.
- `packages/evals`: local eval runner, fixtures, scoring rubrics, and reports.

Keep integrations behind narrow interfaces so the product can upgrade providers without rewriting domain code.

## Core Domain Concepts

### Sermon

A source media item submitted by a church.

Important fields:

- `id`
- `sourceType`: initially `youtube_url`, later `mp4_upload`
- `sourceUrl`
- `title`
- `speaker`
- `durationSeconds`
- `createdAt`

### Processing Job

Tracks the workflow for a submitted sermon.

Suggested statuses:

- `queued`
- `fetching_source`
- `transcribing`
- `selecting_clips`
- `rendering_clips`
- `completed`
- `failed`

Model the state transitions explicitly before adding nontrivial behavior.

### Transcript

Timestamped sermon text.

Important fields:

- `sermonId`
- `language`
- `segments`
- segment `startSeconds`
- segment `endSeconds`
- segment `text`

### Clip Candidate

The model-selected moment before rendering.

Important fields:

- `id`
- `sermonId`
- `category`
- `startSeconds`
- `endSeconds`
- `title`
- `hook`
- `rationale`
- `postCaption`
- `hashtags`
- `confidence`
- `promptVersion`
- `model`

### Rendered Clip

The final downloadable asset.

Important fields:

- `clipCandidateId`
- `format`
- `aspectRatio`
- `videoUrl`
- `thumbnailUrl`
- `subtitleStyle`
- `renderStatus`

## Workflow

The workflow should be explicit and testable:

```text
submit sermon
  -> validate source URL
  -> create sermon and processing job
  -> fetch source metadata
  -> obtain transcript with timestamps
  -> select clip candidates
  -> normalize and validate timestamps
  -> generate captions and hashtags
  -> render clips
  -> mark job completed
```

Expected integration failures should return typed errors, for example:

- invalid YouTube URL
- source unavailable
- transcript unavailable
- model output invalid
- clip timestamps invalid
- render failed
- storage upload failed

Unknown failures should be converted at workflow boundaries into typed workflow failures with enough context for debugging.

## Provider Boundaries

Create interfaces before wiring real providers.

### Source Media Client

Responsible for YouTube metadata and media access.

```ts
type SourceMediaClient = {
  getMetadata(input: SourceMediaInput): Promise<Result<SourceMediaMetadata, SourceMediaError>>;
  getMedia(input: SourceMediaInput): Promise<Result<SourceMediaAsset, SourceMediaError>>;
};
```

### Transcription Client

Responsible for timestamped transcripts.

```ts
type TranscriptionClient = {
  transcribe(input: TranscriptionInput): Promise<Result<Transcript, TranscriptionError>>;
};
```

### Clip Selection Model

Responsible for selecting candidate sermon moments and returning structured output.

```ts
type ClipSelectionModel = {
  selectClips(input: ClipSelectionInput): Promise<Result<ClipSelectionOutput, ModelError>>;
};
```

### Video Renderer

Responsible for clipping, formatting, subtitles, and file output.

```ts
type VideoRenderer = {
  render(input: RenderClipInput): Promise<Result<RenderedClip, RenderError>>;
};
```

### Storage Client

Responsible for storing generated videos, thumbnails, and reports.

```ts
type StorageClient = {
  putObject(input: PutObjectInput): Promise<Result<StoredObject, StorageError>>;
};
```

## Model Strategy

Build for next year's model by avoiding provider-specific assumptions in product code.

Requirements:

- Model calls go through interfaces.
- Model name and provider are configuration, not hardcoded domain behavior.
- Prompts are versioned files.
- Prompt version, model, input hash, and output should be stored for every run.
- Structured outputs must be validated with Zod before entering domain workflows.
- Domain services should consume validated domain objects, not raw provider responses.
- Old sermons should be rerunnable through new prompt and model versions.

The model should produce structured clip recommendations, not prose.

Example output shape:

```ts
type ClipRecommendation = {
  category: "invitation" | "encouragement" | "teaching" | "quote" | "recap";
  startSeconds: number;
  endSeconds: number;
  title: string;
  hook: string;
  rationale: string;
  postCaption: string;
  hashtags: string[];
};
```

## Prompt Strategy

Prompts should ask for clips that are:

- self-contained without requiring too much prior sermon context
- faithful to the speaker's meaning
- emotionally or spiritually meaningful
- clear in the first few seconds
- useful for a church social audience
- appropriate for the requested clip category

Prompts should avoid:

- out-of-context controversy
- clips that start mid-thought
- clips that end without resolution
- generic inspirational language not supported by the sermon
- overdone hashtags or captions that sound like spam

Prompt variants should be easy to compare in evals.

## Evals Strategy

Evals are tests for AI behavior and output quality. They should be first-class, not an afterthought.

### What To Evaluate

For each generated clip candidate, evaluate:

- `standalone_quality`: does the clip make sense without prior context?
- `hook_strength`: does the first few seconds make someone want to keep watching?
- `faithfulness`: does the clip preserve the speaker's meaning?
- `spiritual_substance`: is there meaningful teaching, invitation, comfort, or conviction?
- `category_fit`: does the clip match the requested category?
- `caption_quality`: is the caption natural and post-ready?
- `platform_fit`: is this plausible short-form social content?
- `context_safety`: does the edit avoid misleading the audience?

### Eval Fixtures

Each fixture should include:

- sermon metadata
- timestamped transcript
- optional manually labeled good moments
- expected audience or church context when relevant
- human ratings when available

Suggested fixture path:

```text
packages/evals/fixtures/
  sermon-001/
    metadata.json
    transcript.json
    labels.json
```

### Eval Runner

The local eval runner should support:

- running a prompt and model against fixed transcript fixtures
- saving raw model output
- validating structured output
- scoring output with rubric-based checks
- comparing two runs
- producing a small report suitable for review

Early evals can use a mix of deterministic checks and model-graded rubric checks. Human review should become the source of truth for product quality as soon as real users test the product.

### Upgrade Workflow

Before changing a model or prompt in production:

1. Run existing eval fixtures with the current model and prompt.
2. Run the same fixtures with the candidate model and prompt.
3. Compare quality scores and validation failures.
4. Inspect regressions manually.
5. Promote only if the candidate is equal or better for the product goal.

## Video Rendering Strategy

Use `ffmpeg` behind a renderer interface.

Initial rendering can be simple:

- cut start and end timestamps
- format as vertical 9:16
- center crop or scale with blurred background, depending on source quality
- burn in readable subtitles
- export MP4

Later improvements:

- face-aware crop
- speaker-aware framing
- subtitle style presets
- thumbnail selection
- per-platform export variants

The MVP should prioritize dependable readable clips over complex visual effects.

## Web UX

The first screen should be the actual tool, not a marketing page.

Core flow:

1. Paste sermon YouTube URL.
2. Submit.
3. See processing status.
4. Review generated clips.
5. Download clips and captions.

The UI should feel utilitarian and calm. Churches should understand what to do without reading instructions.

Suggested screens:

- submit sermon
- job status
- clip review
- clip detail or preview

Clip review should show:

- video preview
- category
- title
- suggested caption
- hashtags
- start and end time
- download action

## Testing Strategy

Start with focused tests around:

- URL validation
- job state transitions
- transcript segment validation
- clip timestamp validation
- model output schema validation
- workflow behavior with fake dependencies
- error mapping for expected integration failures
- eval fixture parsing and scoring

Do not depend on real external APIs in ordinary tests. Use fake clients injected through factories.

When persistence is added, use integration tests for database behavior and migrations.

## Observability

Log workflow boundaries:

- sermon submitted
- source fetch started and completed
- transcription started and completed
- clip selection started and completed
- rendering started and completed
- workflow failed

Logs should include stable IDs such as `sermonId`, `jobId`, `promptVersion`, and `model`, but not secrets or unnecessary personal data.

## Staged Implementation Checklist

### Stage 1: Product And Architecture Skeleton

- [x] Scaffold TypeScript monorepo.
- [x] Add strict TypeScript, ESLint, Prettier, and Vitest.
- [x] Add shared domain schemas and Result type.
- [x] Add processing job state model and tests.
- [x] Add HTTP API with validated sermon submission route.
- [x] Add simple web UI for URL submission and job review.
- [x] Add deterministic fake workflow output.

### Stage 2: Evals Foundation

- [x] Add prompt package with versioned clip-selection prompt.
- [x] Add transcript fixture format.
- [x] Add at least one sample sermon transcript fixture.
- [x] Add eval runner.
- [x] Add rubric scoring shape.
- [x] Add run report output.

### Stage 3: Real Model Integration

- [x] Add model provider interface implementation.
- [x] Validate structured model output with Zod.
- [x] Store prompt version, model, input hash, and output metadata.
- [x] Compare at least two prompt versions with eval fixtures.

### Stage 4: Transcript Ingestion

- [x] Add YouTube metadata/media integration.
- [x] Add transcription provider implementation.
- [x] Normalize transcript segments.
- [x] Add transcript validation and error handling.

### Stage 5: Rendering

- [x] Add `ffmpeg` renderer implementation.
- [x] Cut clips from source media.
- [x] Render vertical 9:16 output.
- [x] Burn in subtitles.
- [x] Store downloadable assets.

### Stage 6: Product Hardening

- [ ] Add persistence.
- [ ] Add authentication if needed for external testers.
- [ ] Add job retry strategy.
- [ ] Add production storage.
- [ ] Add human feedback capture for generated clips.
- [ ] Add model and prompt comparison workflow.

## Immediate Next Step

Scaffold the TypeScript monorepo and build the fake end-to-end product loop:

```text
submit YouTube URL -> create job -> fake processing -> generated clip recommendations -> review UI
```

This creates a concrete product surface while preserving the architecture needed for real model, transcript, eval, and rendering integrations.
