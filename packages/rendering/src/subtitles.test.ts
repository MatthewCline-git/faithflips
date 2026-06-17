import { describe, expect, it } from "vitest";
import { clipCandidateSchema, transcriptSchema } from "@faithflips/core";
import { buildSubtitleCues, renderSrt } from "./subtitles.js";

const candidate = clipCandidateSchema.parse({
  id: "clip_1",
  sermonId: "sermon_1",
  category: "teaching",
  startSeconds: 10,
  endSeconds: 20,
  title: "Teaching",
  hook: "A useful hook",
  rationale: "This is a complete short teaching point.",
  postCaption: "A useful caption",
  confidence: 0.9,
  promptVersion: "v1",
  model: "model_1"
});

const transcript = transcriptSchema.parse({
  sermonId: "sermon_1",
  language: "en",
  segments: [
    { startSeconds: 0, endSeconds: 5, text: "Before" },
    { startSeconds: 10.25, endSeconds: 14, text: "God is near" },
    { startSeconds: 18, endSeconds: 23, text: "Keep walking <forward>" }
  ]
});

describe("subtitles", () => {
  it("builds clip-relative cues from overlapping transcript segments", () => {
    expect(buildSubtitleCues({ candidate, transcript })).toEqual([
      { startSeconds: 0.25, endSeconds: 4, text: "God is near" },
      { startSeconds: 8, endSeconds: 13, text: "Keep walking <forward>" }
    ]);
  });

  it("renders SRT with escaped text", () => {
    expect(renderSrt([{ startSeconds: 0.25, endSeconds: 4, text: "Keep walking <forward>" }])).toBe(
      "1\n00:00:00,250 --> 00:00:04,000\nKeep walking &lt;forward&gt;\n"
    );
  });
});
