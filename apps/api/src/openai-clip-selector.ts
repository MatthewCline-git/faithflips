import {
  clipCandidateSchema,
  err,
  ok,
  type ClipCandidate,
  type Result,
  type Transcript
} from "@faithflips/core";
import {
  clipSelectionModelResponseSchema,
  hashModelInput,
  type ClipSelectionModelInput,
  type ClipSelectionModelProvider,
  type ModelProviderError
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

export function createOpenAiClipSelectionProvider(input: {
  readonly apiKey?: string;
  readonly model?: string;
  readonly now?: () => Date;
  readonly timeoutMs?: number;
  readonly maxTranscriptChars?: number;
  readonly logger?: (event: Record<string, unknown>) => void;
}): ClipSelectionModelProvider {
  const provider = "openai";
  const model = input.model ?? "gpt-4.1-mini";
  const now = input.now ?? (() => new Date());
  const timeoutMs = input.timeoutMs ?? 60_000;
  const maxTranscriptChars = input.maxTranscriptChars ?? 100_000;
  const logger = input.logger ?? (() => undefined);

  return {
    provider,
    model,
    async selectClips(selectionInput) {
      const inputHash = hashModelInput(selectionInput);
      if (!input.apiKey) {
        return err({
          type: "provider_failure",
          provider,
          model,
          promptVersion: selectionInput.prompt.version,
          inputHash,
          message: "OPENAI_API_KEY is required for clip selection"
        });
      }

      const controller = new AbortController();
      const timeout = globalThis.setTimeout(() => {
        controller.abort();
      }, timeoutMs);
      const prompt = buildPrompt(selectionInput, maxTranscriptChars);
      logger({
        event: "clip_selection_openai_request_started",
        sermonId: selectionInput.sermonId,
        model,
        transcriptSegmentCount: selectionInput.transcript.segments.length,
        promptCharCount: prompt.length,
        timeoutMs
      });
      let response: Response;
      try {
        response = await fetch("https://api.openai.com/v1/responses", {
          method: "POST",
          signal: controller.signal,
          headers: {
            authorization: `Bearer ${input.apiKey}`,
            "content-type": "application/json"
          },
          body: JSON.stringify({
            model,
            input: prompt,
            temperature: 0.4,
            max_output_tokens: 5000,
            text: {
              format: {
                type: "json_schema",
                name: "clip_selection",
                strict: true,
                schema: {
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
                }
              }
            }
          })
        });
      } catch (error) {
        return err({
          type: "provider_failure",
          provider,
          model,
          promptVersion: selectionInput.prompt.version,
          inputHash,
          message:
            error instanceof Error && error.name === "AbortError"
              ? `OpenAI clip selection timed out after ${String(timeoutMs)}ms`
              : error instanceof Error
                ? error.message
                : "OpenAI clip selection failed"
        });
      } finally {
        globalThis.clearTimeout(timeout);
      }

      if (!response.ok) {
        const errorBody = await response.text();
        const errorDetail = parseOpenAiError(errorBody);
        logger({
          event: "clip_selection_openai_response_received",
          sermonId: selectionInput.sermonId,
          model,
          status: response.status,
          error: errorDetail
        });
        return err({
          type: "provider_failure",
          provider,
          model,
          promptVersion: selectionInput.prompt.version,
          inputHash,
          message: `OpenAI error (HTTP ${String(response.status)}): ${errorDetail}`
        });
      }

      logger({
        event: "clip_selection_openai_response_received",
        sermonId: selectionInput.sermonId,
        model,
        status: response.status
      });

      const rawResponse = (await response.json()) as OpenAiResponse;
      const rawText = extractOutputText(rawResponse);
      if (!rawText) {
        return err({
          type: "provider_failure",
          provider,
          model,
          promptVersion: selectionInput.prompt.version,
          inputHash,
          message: "OpenAI response did not include output text"
        });
      }

      return parseOpenAiClipOutput({
        rawText,
        provider,
        model,
        now,
        selectionInput,
        inputHash
      });
    }
  };
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

function parseOpenAiClipOutput(input: {
  readonly rawText: string;
  readonly provider: string;
  readonly model: string;
  readonly now: () => Date;
  readonly selectionInput: ClipSelectionModelInput;
  readonly inputHash: string;
}): Result<z.infer<typeof clipSelectionModelResponseSchema>, ModelProviderError> {
  const parsedJson = safeJson(input.rawText);
  const parsedOutput = openAiOutputSchema.safeParse(parsedJson);
  if (!parsedOutput.success) {
    return err({
      type: "malformed_output",
      provider: input.provider,
      model: input.model,
      promptVersion: input.selectionInput.prompt.version,
      inputHash: input.inputHash,
      rawOutputHash: hashString(input.rawText),
      issues: parsedOutput.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    });
  }

  const maxDurationSeconds = 60;
  const validClips: ClipCandidate[] = [];

  for (let index = 0; index < parsedOutput.data.clips.length; index++) {
    const clip = parsedOutput.data.clips[index]!;
    const duration = clip.endSeconds - clip.startSeconds;

    if (duration > maxDurationSeconds) {
      console.warn(
        `[REJECTED] Clip ${index + 1} is ${duration.toFixed(1)}s (max ${maxDurationSeconds}s). ` +
          `Timestamps: ${clip.startSeconds}-${clip.endSeconds}. Skipping.`
      );
      continue;
    }

    if (duration <= 0) {
      console.warn(`[REJECTED] Clip ${index + 1} has invalid duration: ${duration}s. Skipping.`);
      continue;
    }

    validClips.push(
      clipCandidateSchema.parse({
        ...clip,
        id: `${input.selectionInput.sermonId}_openai_clip_${String(validClips.length + 1)}`,
        sermonId: input.selectionInput.sermonId,
        promptVersion: input.selectionInput.prompt.version,
        model: input.model
      })
    );
  }

  if (validClips.length === 0) {
    return err({
      type: "malformed_output",
      provider: input.provider,
      model: input.model,
      promptVersion: input.selectionInput.prompt.version,
      inputHash: input.inputHash,
      rawOutputHash: hashString(input.rawText),
      issues: ["All clips exceeded maximum duration of 60 seconds"]
    });
  }

  const clips = validClips;

  return ok(
    clipSelectionModelResponseSchema.parse({
      output: { clips },
      metadata: {
        provider: input.provider,
        model: input.model,
        promptVersion: input.selectionInput.prompt.version,
        inputHash: input.inputHash,
        rawOutputHash: hashString(input.rawText),
        outputHash: hashString(JSON.stringify({ clips })),
        createdAt: input.now().toISOString(),
        validationSucceeded: true
      }
    })
  );
}

function buildPrompt(input: ClipSelectionModelInput, maxTranscriptChars: number): string {
  return [
    "Find the 6 most VIRAL moments from this sermon. Strong emotion = virality.",
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
    "",
    "DURATION REQUIREMENTS (STRICT):",
    "- Target: 21-34 seconds (TikTok algorithm sweet spot)",
    "- HARD MAXIMUM: 60 seconds. Clips over 60s will be REJECTED.",
    "- If a moment runs long, find a natural cut point. Never exceed 60s.",
    "",
    `Sermon ID: ${input.sermonId}`,
    "Transcript:",
    transcriptText(input.transcript, maxTranscriptChars)
  ].join("\n");
}

function transcriptText(transcript: Transcript, maxTranscriptChars: number): string {
  const lines: string[] = [];
  let charCount = 0;

  for (const segment of transcript.segments) {
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

function parseOpenAiError(body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: string; type?: string; code?: string };
    };
    if (parsed.error?.message) {
      const parts = [parsed.error.message];
      if (parsed.error.type) parts.push(`type=${parsed.error.type}`);
      if (parsed.error.code) parts.push(`code=${parsed.error.code}`);
      return parts.join(" | ");
    }
    return body.slice(0, 200);
  } catch {
    return body.slice(0, 200);
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
