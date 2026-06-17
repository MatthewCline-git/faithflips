import { type ClipCandidate, type Transcript } from "@faithflips/core";

export type SubtitleCue = {
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly text: string;
};

export function buildSubtitleCues(input: {
  readonly candidate: ClipCandidate;
  readonly transcript: Transcript;
}): readonly SubtitleCue[] {
  return input.transcript.segments
    .filter(
      (segment) =>
        segment.endSeconds > input.candidate.startSeconds &&
        segment.startSeconds < input.candidate.endSeconds
    )
    .map((segment) => ({
      startSeconds: Math.max(0, roundSeconds(segment.startSeconds - input.candidate.startSeconds)),
      endSeconds: Math.max(0.001, roundSeconds(segment.endSeconds - input.candidate.startSeconds)),
      text: segment.text
    }));
}

export function renderSrt(cues: readonly SubtitleCue[]): string {
  return cues
    .map(
      (cue, index) =>
        `${String(index + 1)}\n${formatSrtTimestamp(cue.startSeconds)} --> ${formatSrtTimestamp(
          cue.endSeconds
        )}\n${escapeSrtText(cue.text)}\n`
    )
    .join("\n");
}

function formatSrtTimestamp(seconds: number): string {
  const milliseconds = Math.round(seconds * 1000);
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const wholeSeconds = Math.floor((milliseconds % 60_000) / 1000);
  const remainingMilliseconds = milliseconds % 1000;

  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(wholeSeconds, 2)},${pad(
    remainingMilliseconds,
    3
  )}`;
}

function escapeSrtText(value: string): string {
  return value.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function pad(value: number, length: number): string {
  return value.toString().padStart(length, "0");
}

function roundSeconds(value: number): number {
  return Math.round(value * 1000) / 1000;
}
