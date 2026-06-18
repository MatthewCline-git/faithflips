import {
  clipCandidateSchema,
  err,
  ok,
  type ClipCandidate,
  type Transcript
} from "@faithflips/core";
import {
  clipSelectionModelResponseSchema,
  hashModelInput,
  type ClipSelectionModelInput,
  type ClipSelectionModelProvider
} from "@faithflips/model";
import { z } from "zod";

const openAiClipSchema = z.object({
  reasoning: z.string().min(1),
  startSeconds: z.number().nonnegative(),
  endSeconds: z.number().positive(),
  title: z.string().min(1),
  hook: z.string().min(1),
  rationale: z.string().min(1),
  postCaption: z.string().min(1),
  firstWords: z.string().min(1),
  lastWords: z.string().min(1),
  confidence: z.number().min(0).max(1)
});

const openAiOutputSchema = z.object({
  clips: z.array(openAiClipSchema).min(1).max(6)
});

function rankingOutputSchema(maxItems: number) {
  return z.object({
    selected: z.array(z.number().int().nonnegative()).min(1).max(maxItems)
  });
}

type RawClip = z.infer<typeof openAiClipSchema>;

type TranscriptChunk = {
  readonly segments: Transcript["segments"];
  readonly startSeconds: number;
  readonly endSeconds: number;
};

// Extracted as a constant to avoid duplicating the JSON schema object across
// chunk calls and the single-pass fallback.
const CLIP_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["clips"],
  properties: {
    clips: {
      type: "array",
      minItems: 1,
      maxItems: 6,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "reasoning",
          "startSeconds",
          "endSeconds",
          "title",
          "hook",
          "rationale",
          "postCaption",
          "firstWords",
          "lastWords",
          "confidence"
        ],
        properties: {
          reasoning: {
            type: "string",
            description:
              "Your analysis: why this moment is viral, what emotion it triggers, why the timestamps are precise"
          },
          startSeconds: { type: "number" },
          endSeconds: { type: "number" },
          title: { type: "string" },
          hook: { type: "string" },
          rationale: { type: "string" },
          postCaption: { type: "string" },
          firstWords: { type: "string" },
          lastWords: { type: "string" },
          confidence: { type: "number" }
        }
      }
    }
  }
};

export function createOpenAiClipSelectionProvider(input: {
  readonly apiKey?: string;
  readonly model?: string;
  readonly now?: () => Date;
  readonly timeoutMs?: number;
  readonly maxTranscriptChars?: number;
  readonly chunkDurationSeconds?: number;
  readonly chunkOverlapSeconds?: number;
  readonly clipsPerChunk?: number;
  readonly logger?: (event: Record<string, unknown>) => void;
}): ClipSelectionModelProvider {
  const provider = "openai";
  const model = input.model ?? "gpt-4.1-mini";
  const now = input.now ?? (() => new Date());
  const timeoutMs = input.timeoutMs ?? 60_000;
  const maxTranscriptChars = input.maxTranscriptChars ?? 100_000;
  const chunkDurationSeconds = input.chunkDurationSeconds ?? 600;
  const chunkOverlapSeconds = input.chunkOverlapSeconds ?? 120;
  const clipsPerChunk = input.clipsPerChunk ?? 3;
  const logger = input.logger ?? (() => undefined);
  const apiKey = input.apiKey;

  return {
    provider,
    model,
    async selectClips(selectionInput) {
      const inputHash = hashModelInput(selectionInput);
      if (!apiKey) {
        return err({
          type: "provider_failure",
          provider,
          model,
          promptVersion: selectionInput.prompt.version,
          inputHash,
          message: "OPENAI_API_KEY is required for clip selection"
        });
      }

      const chunks = chunkTranscript(
        selectionInput.transcript,
        chunkDurationSeconds,
        chunkOverlapSeconds
      );

      logger({
        event: "clip_selection_started",
        sermonId: selectionInput.sermonId,
        chunkCount: chunks.length,
        totalSegments: selectionInput.transcript.segments.length
      });

      const chunkCandidateSets = await Promise.all(
        chunks.map((chunk, i) =>
          fetchChunkCandidates({
            apiKey,
            model,
            selectionInput,
            chunk,
            chunkIndex: i,
            totalChunks: chunks.length,
            clipsPerChunk,
            maxTranscriptChars,
            timeoutMs,
            logger
          })
        )
      );

      const allCandidates = chunkCandidateSets.flatMap((r) => r ?? []);

      logger({
        event: "clip_selection_chunks_complete",
        sermonId: selectionInput.sermonId,
        totalCandidates: allCandidates.length
      });

      if (allCandidates.length === 0) {
        return err({
          type: "provider_failure",
          provider,
          model,
          promptVersion: selectionInput.prompt.version,
          inputHash,
          message: "No valid clips found across any sermon section"
        });
      }

      const desiredCount = selectionInput.clipCount ?? 6;
      let finalRawClips: RawClip[];
      if (allCandidates.length <= desiredCount) {
        finalRawClips = allCandidates;
      } else {
        const ranked = await rankCandidates({
          apiKey,
          model,
          candidates: allCandidates,
          desiredCount,
          timeoutMs,
          logger,
          sermonId: selectionInput.sermonId
        });
        finalRawClips =
          ranked ??
          [...allCandidates].sort((a, b) => b.confidence - a.confidence).slice(0, desiredCount);
      }

      const validClips: ClipCandidate[] = [];
      for (const clip of finalRawClips) {
        const duration = clip.endSeconds - clip.startSeconds;
        if (duration <= 0 || duration > 60) continue;
        validClips.push(
          clipCandidateSchema.parse({
            ...clip,
            id: `${selectionInput.sermonId}_openai_clip_${String(validClips.length + 1)}`,
            sermonId: selectionInput.sermonId,
            promptVersion: selectionInput.prompt.version,
            model
          })
        );
      }

      if (validClips.length === 0) {
        return err({
          type: "malformed_output",
          provider,
          model,
          promptVersion: selectionInput.prompt.version,
          inputHash,
          rawOutputHash: "",
          issues: ["No valid clips after final filtering"]
        });
      }

      const clips = validClips;
      const outputHash = hashString(JSON.stringify({ clips }));

      return ok(
        clipSelectionModelResponseSchema.parse({
          output: { clips },
          metadata: {
            provider,
            model,
            promptVersion: selectionInput.prompt.version,
            inputHash,
            rawOutputHash: outputHash,
            outputHash,
            createdAt: now().toISOString(),
            validationSucceeded: true
          }
        })
      );
    }
  };
}

function chunkTranscript(
  transcript: Transcript,
  chunkDurationSeconds: number,
  overlapSeconds: number
): TranscriptChunk[] {
  const totalDuration = transcript.segments[transcript.segments.length - 1]?.endSeconds ?? 0;

  if (totalDuration <= chunkDurationSeconds) {
    return [{ segments: transcript.segments, startSeconds: 0, endSeconds: totalDuration }];
  }

  const stride = chunkDurationSeconds - overlapSeconds;
  if (stride <= 0) {
    return [{ segments: transcript.segments, startSeconds: 0, endSeconds: totalDuration }];
  }

  const chunks: TranscriptChunk[] = [];
  let chunkStart = 0;

  while (chunkStart < totalDuration) {
    const chunkEnd = chunkStart + chunkDurationSeconds;
    const segments = transcript.segments.filter(
      (s) => s.endSeconds > chunkStart && s.startSeconds < chunkEnd
    );
    if (segments.length > 0) {
      chunks.push({
        segments,
        startSeconds: chunkStart,
        endSeconds: Math.min(chunkEnd, totalDuration)
      });
    }
    chunkStart += stride;
  }

  return chunks.length > 0
    ? chunks
    : [{ segments: transcript.segments, startSeconds: 0, endSeconds: totalDuration }];
}

async function fetchChunkCandidates(opts: {
  readonly apiKey: string;
  readonly model: string;
  readonly selectionInput: ClipSelectionModelInput;
  readonly chunk: TranscriptChunk;
  readonly chunkIndex: number;
  readonly totalChunks: number;
  readonly clipsPerChunk: number;
  readonly maxTranscriptChars: number;
  readonly timeoutMs: number;
  readonly logger: (event: Record<string, unknown>) => void;
}): Promise<RawClip[] | null> {
  const {
    apiKey,
    model,
    selectionInput,
    chunk,
    chunkIndex,
    totalChunks,
    clipsPerChunk,
    maxTranscriptChars,
    timeoutMs,
    logger
  } = opts;

  const prompt = buildChunkPrompt(
    selectionInput,
    chunk,
    chunkIndex,
    totalChunks,
    clipsPerChunk,
    maxTranscriptChars
  );

  logger({
    event: "clip_selection_chunk_request_started",
    sermonId: selectionInput.sermonId,
    chunkIndex,
    totalChunks,
    chunkStartSeconds: chunk.startSeconds,
    chunkEndSeconds: chunk.endSeconds
  });

  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  let response: Response;
  try {
    response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model,
        input: prompt,
        temperature: 0.4,
        max_output_tokens: Math.max(1000, Math.ceil((5000 * clipsPerChunk) / 6)),
        text: {
          format: {
            type: "json_schema",
            name: "clip_selection",
            strict: true,
            schema: CLIP_JSON_SCHEMA
          }
        }
      })
    });
  } catch (error) {
    logger({
      event: "clip_selection_chunk_request_failed",
      sermonId: selectionInput.sermonId,
      chunkIndex,
      error: error instanceof Error ? error.message : "unknown"
    });
    return null;
  } finally {
    globalThis.clearTimeout(timeout);
  }

  if (!response.ok) {
    logger({
      event: "clip_selection_chunk_response_error",
      sermonId: selectionInput.sermonId,
      chunkIndex,
      status: response.status
    });
    return null;
  }

  const rawResponse = (await response.json()) as OpenAiResponse;
  const rawText = extractOutputText(rawResponse);
  if (!rawText) return null;

  const parsedJson = safeJson(rawText);
  const parsedOutput = openAiOutputSchema.safeParse(parsedJson);
  if (!parsedOutput.success) {
    logger({
      event: "clip_selection_chunk_parse_failed",
      sermonId: selectionInput.sermonId,
      chunkIndex,
      issues: parsedOutput.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`)
    });
    return null;
  }

  const validClips = parsedOutput.data.clips.filter((clip) => {
    const duration = clip.endSeconds - clip.startSeconds;
    return duration > 0 && duration <= 60;
  });

  logger({
    event: "clip_selection_chunk_complete",
    sermonId: selectionInput.sermonId,
    chunkIndex,
    clipsFound: validClips.length
  });

  return validClips;
}

async function rankCandidates(opts: {
  readonly apiKey: string;
  readonly model: string;
  readonly candidates: RawClip[];
  readonly desiredCount: number;
  readonly timeoutMs: number;
  readonly logger: (event: Record<string, unknown>) => void;
  readonly sermonId: string;
}): Promise<RawClip[] | null> {
  const { apiKey, model, candidates, desiredCount, timeoutMs, logger, sermonId } = opts;

  const prompt = buildRankingPrompt(candidates, desiredCount);

  logger({
    event: "clip_selection_ranking_started",
    sermonId,
    candidateCount: candidates.length,
    desiredCount
  });

  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  let response: Response;
  try {
    response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model,
        input: prompt,
        temperature: 0.2,
        max_output_tokens: 200,
        text: {
          format: {
            type: "json_schema",
            name: "clip_ranking",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["selected"],
              properties: {
                selected: {
                  type: "array",
                  minItems: 1,
                  maxItems: desiredCount,
                  items: { type: "integer", minimum: 0 }
                }
              }
            }
          }
        }
      })
    });
  } catch (error) {
    logger({
      event: "clip_selection_ranking_failed",
      sermonId,
      error: error instanceof Error ? error.message : "unknown"
    });
    return null;
  } finally {
    globalThis.clearTimeout(timeout);
  }

  if (!response.ok) {
    logger({ event: "clip_selection_ranking_response_error", sermonId, status: response.status });
    return null;
  }

  const rawResponse = (await response.json()) as OpenAiResponse;
  const rawText = extractOutputText(rawResponse);
  if (!rawText) return null;

  const parsedJson = safeJson(rawText);
  const parsedOutput = rankingOutputSchema(desiredCount).safeParse(parsedJson);
  if (!parsedOutput.success) {
    logger({
      event: "clip_selection_ranking_parse_failed",
      sermonId,
      issues: parsedOutput.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`)
    });
    return null;
  }

  const selected = parsedOutput.data.selected
    .filter((i) => i >= 0 && i < candidates.length)
    .slice(0, desiredCount)
    .flatMap((i) => {
      const candidate = candidates[i];
      return candidate ? [candidate] : [];
    });

  logger({
    event: "clip_selection_ranking_complete",
    sermonId,
    selectedCount: selected.length
  });

  return selected.length > 0 ? selected : null;
}

function buildChunkPrompt(
  input: ClipSelectionModelInput,
  chunk: TranscriptChunk,
  chunkIndex: number,
  totalChunks: number,
  clipsPerChunk: number,
  maxTranscriptChars: number
): string {
  const startMin = Math.round(chunk.startSeconds / 60);
  const endMin = Math.round(chunk.endSeconds / 60);
  const usesCaptionRanking = input.prompt.version === "clip-selection-v3";
  const captionInstructions = usesCaptionRanking
    ? [
        "",
        "CAPTION ANGLE SELECTION:",
        "- Do not summarize the sermon. Identify the psychological angle of the clip.",
        "- Internally generate these caption angles before choosing the final hook and postCaption: conviction, curiosity, encouragement, challenge, second-person direct address, and direct quote.",
        "- Prefer specific second-person hooks and direct quotes from the transcript over generic inspirational phrasing.",
        "- Strong hooks usually create tension before resolution: conviction plus hope.",
        "- Avoid generic Christian phrases, church bulletin wording, emojis, hashtags, and openers like 'In this sermon' or 'Pastor explains'.",
        "- Use the first 10 seconds after the clip start to amplify tension that is already present in the opening."
      ]
    : [];

  return [
    `Find the ${String(clipsPerChunk)} most VIRAL moments from SECTION ${String(chunkIndex + 1)} of ${String(totalChunks)} of this sermon (minutes ${String(startMin)}–${String(endMin)}).`,
    "",
    "Look for moments that are:",
    "- Provocative or challenging",
    "- Inspiring or convicting",
    "- Atomic and digestible (one clear idea)",
    "- Standalone (makes sense without context)",
    "- Emotionally charged - anger, hope, conviction, urgency, tenderness",
    "",
    "CRITICAL - Complete thoughts only:",
    "- Start at the BEGINNING of a sentence, not mid-thought",
    "- End at a natural pause or sentence end",
    "- Include firstWords and lastWords so we can verify clean cuts",
    "",
    "For each clip:",
    "- reasoning: THINK FIRST. What makes this moment viral? What emotion does it trigger? Why are these exact timestamps right?",
    "- hook: Direct, personal. 'If you're struggling with X...' or 'Nobody talks about this...' NO generic openers.",
    "- postCaption: Like a real person posting, not a brand. Short. Punchy. No hashtags.",
    "- title: 3-5 words, lowercase",
    "- firstWords: First 5-6 words spoken",
    "- lastWords: Last 5-6 words spoken",
    ...captionInstructions,
    "",
    "DURATION REQUIREMENTS (STRICT):",
    "- Target: 21-34 seconds (TikTok algorithm sweet spot)",
    "- HARD MAXIMUM: 60 seconds. Clips over 60s will be REJECTED.",
    "- If a moment runs long, find a natural cut point. Never exceed 60s.",
    "",
    `Sermon ID: ${input.sermonId}`,
    "Transcript:",
    transcriptText(chunk.segments, maxTranscriptChars)
  ].join("\n");
}

function buildRankingPrompt(candidates: RawClip[], desiredCount: number): string {
  const candidateList = candidates
    .map((c, i) =>
      [
        `${String(i)}. [${String(Math.round(c.startSeconds))}s–${String(Math.round(c.endSeconds))}s] "${c.hook}"`,
        `   confidence: ${c.confidence.toFixed(2)} | opens: "${c.firstWords}" | closes: "${c.lastWords}"`,
        `   rationale: ${c.rationale}`,
        `   caption: ${c.postCaption}`
      ].join("\n")
    )
    .join("\n\n");

  return [
    `You have ${String(candidates.length)} clip candidates from different sections of a sermon. Select the ${String(desiredCount)} best.`,
    "",
    "Choose clips that are:",
    "- Strongest hooks (most scroll-stopping)",
    "- Varied topics (don't cluster on the same theme)",
    "- Spread across the sermon timeline",
    "- High standalone value (makes sense without context)",
    "- Best caption psychology: specific direct address, conviction plus hope, shareability, clarity, and theological faithfulness",
    "- Strong direct quotes when the pastor already said the memorable line",
    "- Least likely to read like a sermon summary or generic Christian social copy",
    "",
    `Return the indices (0-based integers, 0–${String(candidates.length - 1)}) of your ${String(desiredCount)} chosen clips.`,
    "",
    "CANDIDATES:",
    candidateList
  ].join("\n");
}

type OpenAiResponse = {
  readonly output_text?: unknown;
  readonly output?: readonly {
    readonly content?: readonly {
      readonly type?: string;
      readonly text?: unknown;
    }[];
  }[];
};

function transcriptText(segments: Transcript["segments"], maxTranscriptChars: number): string {
  const lines: string[] = [];
  let charCount = 0;

  for (const segment of segments) {
    const start = Math.round(segment.startSeconds);
    const end = Math.round(segment.endSeconds);
    const line = `[${String(start)}-${String(end)}] ${segment.text}`;
    if (charCount + line.length > maxTranscriptChars) {
      lines.push(
        `[truncated] Transcript continues beyond this point; choose only from timestamps shown above.`
      );
      break;
    }
    lines.push(line);
    charCount += line.length;
  }

  return lines.join("\n");
}

function extractOutputText(response: OpenAiResponse): string | undefined {
  if (typeof response.output_text === "string") {
    return response.output_text;
  }

  for (const output of response.output ?? []) {
    for (const content of output.content ?? []) {
      if (content.type === "output_text" && typeof content.text === "string") {
        return content.text;
      }
    }
  }

  return undefined;
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function hashString(value: string): string {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
