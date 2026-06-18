import { createHash } from "node:crypto";
import {
  clipCandidateSchema,
  err,
  ok,
  type ClipCandidate,
  type ClipCategory,
  type Result,
  type Transcript
} from "@faithflips/core";
import type { ClipSelectionPrompt } from "@faithflips/prompts";
import { z } from "zod";

export const clipSelectionStructuredOutputSchema = z.object({
  clips: z.array(clipCandidateSchema).min(1)
});

export const modelOutputMetadataSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  promptVersion: z.string().min(1),
  inputHash: z.string().min(1),
  rawOutputHash: z.string().min(1),
  outputHash: z.string().min(1),
  createdAt: z.iso.datetime(),
  validationSucceeded: z.boolean()
});

export const clipSelectionModelResponseSchema = z.object({
  output: clipSelectionStructuredOutputSchema,
  metadata: modelOutputMetadataSchema
});

export type ClipSelectionStructuredOutput = z.infer<typeof clipSelectionStructuredOutputSchema>;
export type ModelOutputMetadata = z.infer<typeof modelOutputMetadataSchema>;
export type ClipSelectionModelResponse = z.infer<typeof clipSelectionModelResponseSchema>;

export type ModelProviderError =
  | {
      readonly type: "malformed_output";
      readonly provider: string;
      readonly model: string;
      readonly promptVersion: string;
      readonly inputHash: string;
      readonly rawOutputHash: string;
      readonly issues: readonly string[];
    }
  | {
      readonly type: "provider_failure";
      readonly provider: string;
      readonly model: string;
      readonly promptVersion: string;
      readonly inputHash: string;
      readonly message: string;
    };

export type ClipSelectionHint = {
  readonly category: ClipCategory;
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly note: string;
};

export type ClipSelectionModelInput = {
  readonly sermonId: string;
  readonly transcript: Transcript;
  readonly prompt: ClipSelectionPrompt;
  readonly hints?: readonly ClipSelectionHint[];
  readonly clipCount?: number;
};

export type ClipSelectionModelProvider = {
  readonly provider: string;
  readonly model: string;
  selectClips(
    input: ClipSelectionModelInput
  ): Promise<Result<ClipSelectionModelResponse, ModelProviderError>>;
};

export function createDeterministicClipSelectionProvider(input?: {
  readonly provider?: string;
  readonly model?: string;
  readonly now?: () => Date;
}): ClipSelectionModelProvider {
  const provider = input?.provider ?? "local";
  const model = input?.model ?? "deterministic-clip-selector";
  const now = input?.now ?? (() => new Date());

  return {
    provider,
    model,
    selectClips(selectionInput) {
      const inputHash = hashModelInput(selectionInput);

      try {
        const rawOutput = {
          clips: chooseMoments(selectionInput).map((moment, index) =>
            buildCandidate({
              sermonId: selectionInput.sermonId,
              transcript: selectionInput.transcript,
              prompt: selectionInput.prompt,
              moment,
              index,
              model
            })
          )
        };
        const rawOutputHash = hashJson(rawOutput);
        const parsed = clipSelectionStructuredOutputSchema.safeParse(rawOutput);

        if (!parsed.success) {
          return Promise.resolve(
            err({
              type: "malformed_output",
              provider,
              model,
              promptVersion: selectionInput.prompt.version,
              inputHash,
              rawOutputHash,
              issues: parsed.error.issues.map(
                (issue) => `${issue.path.join(".")}: ${issue.message}`
              )
            })
          );
        }

        const response = clipSelectionModelResponseSchema.parse({
          output: parsed.data,
          metadata: {
            provider,
            model,
            promptVersion: selectionInput.prompt.version,
            inputHash,
            rawOutputHash,
            outputHash: hashJson(parsed.data),
            createdAt: now().toISOString(),
            validationSucceeded: true
          }
        });

        return Promise.resolve(ok(response));
      } catch (error) {
        return Promise.resolve(
          err({
            type: "provider_failure",
            provider,
            model,
            promptVersion: selectionInput.prompt.version,
            inputHash,
            message: error instanceof Error ? error.message : "Unknown model provider failure"
          })
        );
      }
    }
  };
}

function chooseMoments(input: ClipSelectionModelInput): readonly ClipSelectionHint[] {
  const count = input.clipCount ?? 6;
  if (input.hints && input.hints.length > 0) {
    return input.hints.slice(0, count);
  }

  return input.transcript.segments.slice(0, count).map((segment) => ({
    category: inferCategory(segment.text),
    startSeconds: segment.startSeconds,
    endSeconds: segment.endSeconds,
    note: `Selected from transcript segment starting at ${String(segment.startSeconds)} seconds.`
  }));
}

function buildCandidate(input: {
  readonly sermonId: string;
  readonly transcript: Transcript;
  readonly prompt: ClipSelectionPrompt;
  readonly moment: ClipSelectionHint;
  readonly index: number;
  readonly model: string;
}): ClipCandidate {
  const transcriptText = textForMoment(input.transcript, input.moment);
  const profile = promptProfile(input.prompt.version);

  return clipCandidateSchema.parse({
    id: `${input.sermonId}_${profile.idLabel}_clip_${String(input.index + 1)}`,
    sermonId: input.sermonId,
    startSeconds: input.moment.startSeconds,
    endSeconds: input.moment.endSeconds,
    title: titleForCategory(input.moment.category, profile.variantIndex),
    hook: hookForCategory(input.moment.category, profile.variantIndex),
    rationale: `${input.moment.note} Transcript support: ${firstSentence(transcriptText)}`,
    postCaption: captionForCategory(input.moment.category, profile.variantIndex),
    confidence: profile.confidence,
    promptVersion: input.prompt.version,
    model: input.model
  });
}

function promptProfile(promptVersion: string): {
  readonly idLabel: string;
  readonly variantIndex: 0 | 1 | 2;
  readonly confidence: number;
} {
  if (promptVersion === "clip-selection-v3") {
    return { idLabel: "caption_ranked", variantIndex: 2, confidence: 0.88 };
  }
  if (promptVersion === "clip-selection-v2") {
    return { idLabel: "focused", variantIndex: 1, confidence: 0.84 };
  }
  return { idLabel: "baseline", variantIndex: 0, confidence: 0.8 };
}

function inferCategory(text: string): ClipCategory {
  const lower = text.toLowerCase();
  if (lower.includes("come") || lower.includes("respond")) {
    return "invitation";
  }
  if (lower.includes("grace") || lower.includes("hope") || lower.includes("tired")) {
    return "encouragement";
  }
  if (lower.includes("faith") || lower.includes("practice")) {
    return "teaching";
  }
  return "recap";
}

function textForMoment(transcript: Transcript, moment: ClipSelectionHint): string {
  return transcript.segments
    .filter(
      (segment) =>
        segment.startSeconds < moment.endSeconds && moment.startSeconds < segment.endSeconds
    )
    .map((segment) => segment.text)
    .join(" ");
}

function titleForCategory(category: ClipCategory, variantIndex: 0 | 1 | 2): string {
  const titles = {
    invitation: ["Bring God Your Actual Life", "Respond With Your Real Life", "Stop Waiting"],
    encouragement: ["Grace Meets The Tired", "Grace For The Tired Week", "Tired But Met"],
    teaching: ["Faith Becomes Visible", "Faith You Can Practice", "Faith Needs Feet"],
    quote: [
      "A Sermon Moment Worth Remembering",
      "A Line To Carry This Week",
      "Text This To Someone"
    ],
    recap: ["The Message In One Moment", "The Heart Of The Message", "This Is For You"]
  } as const;
  return titles[category][variantIndex];
}

function hookForCategory(category: ClipCategory, variantIndex: 0 | 1 | 2): string {
  const hooks = {
    invitation: [
      "If you have been waiting to respond, today is for you.",
      "You can bring God your real life today.",
      "You are waiting to feel ready, but God is asking for honest."
    ],
    encouragement: [
      "If this week has worn you down, grace meets you here.",
      "Grace is not waiting for you to be less tired.",
      "You are not too tired for grace to meet you here."
    ],
    teaching: [
      "Faith becomes visible in what you do next.",
      "Faith is practiced in ordinary choices.",
      "You keep calling it belief, but your next choice will tell the truth."
    ],
    quote: [
      "This one sentence can reshape your week.",
      "Carry this sentence into the week ahead.",
      "This is the line someone needs you to send them."
    ],
    recap: [
      "Here is the heart of this week's message.",
      "This is the message to remember this week.",
      "You do not need the whole sermon to know this part is for you."
    ]
  } as const;
  return hooks[category][variantIndex];
}

function captionForCategory(category: ClipCategory, variantIndex: 0 | 1 | 2): string {
  const captions = {
    invitation: [
      "You do not have to wait until everything is together to respond to God today.",
      "Bring your honest life to God today, not a polished version of it.",
      "Stop protecting the version of your life God is trying to heal."
    ],
    encouragement: [
      "Grace meets tired people with mercy, honesty, and real hope for the week ahead.",
      "For the tired week: grace meets you with mercy and real hope.",
      "You are tired, but you are not outside the reach of mercy."
    ],
    teaching: [
      "Faith becomes visible in ordinary choices: patience, forgiveness, courage, and prayer.",
      "Faith becomes visible in ordinary choices, not only big moments.",
      "If faith never reaches your next decision, it is only agreement."
    ],
    quote: [
      "A short sermon moment for anyone carrying this message into the week.",
      "A short sermon moment to carry into the week.",
      "This is the kind of line you send before someone gives up."
    ],
    recap: [
      "The heart of the message: receive grace, then practice grace in ordinary life.",
      "Receive grace, then practice grace in ordinary life this week.",
      "You are closer to the point than you think. Let this part land."
    ]
  } as const;
  return captions[category][variantIndex];
}

function firstSentence(text: string): string {
  return text.split(".")[0]?.trim() ?? text;
}

export function hashModelInput(input: ClipSelectionModelInput): string {
  return hashJson({
    sermonId: input.sermonId,
    transcript: input.transcript,
    prompt: {
      id: input.prompt.id,
      version: input.prompt.version,
      messages: input.prompt.messages,
      outputContract: input.prompt.outputContract
    },
    hints: input.hints ?? [],
    clipCount: input.clipCount ?? 6
  });
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}
