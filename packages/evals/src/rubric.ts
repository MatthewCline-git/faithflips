import type { ClipCandidate, Transcript } from "@faithflips/core";
import { z } from "zod";
import type { EvalFixture } from "./fixture.js";

export const rubricDimensionSchema = z.enum([
  "standalone_quality",
  "hook_strength",
  "faithfulness",
  "spiritual_substance",
  "emotional_impact",
  "caption_quality",
  "platform_fit",
  "context_safety"
]);

export const rubricScoreSchema = z.object({
  dimension: rubricDimensionSchema,
  score: z.number().min(0).max(5),
  reason: z.string().min(1)
});

export const clipEvalScoreSchema = z.object({
  clipId: z.string().min(1),
  averageScore: z.number().min(0).max(5),
  scores: z.array(rubricScoreSchema)
});

export type RubricDimension = z.infer<typeof rubricDimensionSchema>;
export type RubricScore = z.infer<typeof rubricScoreSchema>;
export type ClipEvalScore = z.infer<typeof clipEvalScoreSchema>;

export function scoreClipCandidate(fixture: EvalFixture, candidate: ClipCandidate): ClipEvalScore {
  const transcriptText = transcriptTextForRange(
    fixture.transcript,
    candidate.startSeconds,
    candidate.endSeconds
  );
  const scores: readonly RubricScore[] = [
    scoreStandaloneQuality(candidate, transcriptText),
    scoreHookStrength(candidate),
    scoreFaithfulness(candidate, transcriptText),
    scoreSpiritualSubstance(candidate, transcriptText),
    scoreEmotionalImpact(candidate, transcriptText),
    scoreCaptionQuality(candidate),
    scorePlatformFit(candidate),
    scoreContextSafety(candidate, transcriptText)
  ];
  const averageScore = scores.reduce((total, score) => total + score.score, 0) / scores.length;

  return clipEvalScoreSchema.parse({
    clipId: candidate.id,
    averageScore: roundScore(averageScore),
    scores
  });
}

function scoreStandaloneQuality(candidate: ClipCandidate, transcriptText: string): RubricScore {
  const duration = candidate.endSeconds - candidate.startSeconds;
  const score = duration >= 25 && duration <= 75 && transcriptText.length >= 160 ? 5 : 3;
  return {
    dimension: "standalone_quality",
    score,
    reason:
      score === 5
        ? "Clip duration and transcript range support a complete thought."
        : "Clip may be too short, too long, or thin on context."
  };
}

function scoreHookStrength(candidate: ClipCandidate): RubricScore {
  const hasDirectHook = /you|your|today|this week|if/i.test(candidate.hook);
  const score = candidate.hook.length >= 20 && hasDirectHook ? 5 : 3;
  return {
    dimension: "hook_strength",
    score,
    reason:
      score === 5
        ? "Hook is direct and specific enough for the first seconds."
        : "Hook is present but could be more immediate."
  };
}

function scoreFaithfulness(candidate: ClipCandidate, transcriptText: string): RubricScore {
  const candidateWords = importantWords(
    `${candidate.title} ${candidate.hook} ${candidate.rationale} ${candidate.postCaption}`
  );
  const transcriptWords = new Set(importantWords(transcriptText));
  const overlap = candidateWords.filter((word) => transcriptWords.has(word)).length;
  const score = overlap >= 4 ? 5 : overlap >= 2 ? 4 : 2;
  return {
    dimension: "faithfulness",
    score,
    reason:
      score >= 4
        ? "Candidate language is grounded in the selected transcript range."
        : "Candidate language has weak lexical support in the transcript range."
  };
}

function scoreSpiritualSubstance(candidate: ClipCandidate, transcriptText: string): RubricScore {
  const combined = `${candidate.hook} ${candidate.rationale} ${transcriptText}`;
  const score = /grace|jesus|god|faith|pray|mercy|church|forgiveness/i.test(combined) ? 5 : 2;
  return {
    dimension: "spiritual_substance",
    score,
    reason:
      score === 5
        ? "Clip contains explicit spiritual or pastoral substance."
        : "Clip lacks clear spiritual substance."
  };
}

function scoreEmotionalImpact(candidate: ClipCandidate, transcriptText: string): RubricScore {
  const emotionWords =
    /challenge|provok|inspir|convict|hope|fear|joy|anger|urgent|tender|powerful|bold|raw|real/i;
  const combined = `${candidate.hook} ${candidate.postCaption} ${transcriptText}`;
  const hasEmotion = emotionWords.test(combined);
  const hookIsPersonal = /you|your|if you/i.test(candidate.hook);
  const score = hasEmotion && hookIsPersonal ? 5 : hasEmotion || hookIsPersonal ? 4 : 2;
  return {
    dimension: "emotional_impact",
    score,
    reason:
      score >= 4
        ? "Clip has emotional language and personal hook."
        : "Clip lacks strong emotional resonance."
  };
}

function scoreCaptionQuality(candidate: ClipCandidate): RubricScore {
  const score =
    candidate.postCaption.length >= 20 && candidate.postCaption.length <= 200 ? 5 : 3;
  return {
    dimension: "caption_quality",
    score,
    reason:
      score === 5
        ? "Caption length is appropriate for posting."
        : "Caption may need editorial review."
  };
}

function scorePlatformFit(candidate: ClipCandidate): RubricScore {
  const duration = candidate.endSeconds - candidate.startSeconds;
  const score = duration >= 20 && duration <= 90 ? 5 : 2;
  return {
    dimension: "platform_fit",
    score,
    reason:
      score === 5
        ? "Duration fits short-form social constraints."
        : "Duration is outside the target short-form range."
  };
}

function scoreContextSafety(candidate: ClipCandidate, transcriptText: string): RubricScore {
  const score =
    transcriptText.length > 0 && !/controversy|politic|attack/i.test(transcriptText) ? 5 : 3;
  return {
    dimension: "context_safety",
    score,
    reason:
      score === 5
        ? "Selected range has enough transcript support and no obvious context risk."
        : "Selected range may need context review."
  };
}

function transcriptTextForRange(
  transcript: Transcript,
  startSeconds: number,
  endSeconds: number
): string {
  return transcript.segments
    .filter((segment) =>
      rangesOverlap(
        { startSeconds: segment.startSeconds, endSeconds: segment.endSeconds },
        { startSeconds, endSeconds }
      )
    )
    .map((segment) => segment.text)
    .join(" ");
}

function rangesOverlap(
  left: { readonly startSeconds: number; readonly endSeconds: number },
  right: { readonly startSeconds: number; readonly endSeconds: number }
): boolean {
  return left.startSeconds < right.endSeconds && right.startSeconds < left.endSeconds;
}

function importantWords(text: string): readonly string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 4);
}

function roundScore(score: number): number {
  return Math.round(score * 100) / 100;
}
