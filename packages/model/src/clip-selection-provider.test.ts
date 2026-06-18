import {
  clipSelectionPromptV1,
  clipSelectionPromptV2,
  clipSelectionPromptV3
} from "@faithflips/prompts";
import { describe, expect, it } from "vitest";
import {
  createDeterministicClipSelectionProvider,
  hashModelInput
} from "./clip-selection-provider.js";

describe("deterministic clip selection provider", () => {
  it("returns validated structured output with model metadata", async () => {
    const provider = createDeterministicClipSelectionProvider({
      now: () => new Date("2026-01-05T00:00:00.000Z")
    });

    const result = await provider.selectClips({
      sermonId: transcript.sermonId,
      transcript,
      prompt: clipSelectionPromptV1
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.output.clips).toHaveLength(1);
    expect(result.value.metadata).toMatchObject({
      provider: "local",
      model: "deterministic-clip-selector",
      promptVersion: "clip-selection-v1",
      validationSucceeded: true
    });
    expect(result.value.metadata.inputHash).toBe(
      hashModelInput({
        sermonId: transcript.sermonId,
        transcript,
        prompt: clipSelectionPromptV1
      })
    );
  });

  it("uses prompt version when producing candidate metadata", async () => {
    const provider = createDeterministicClipSelectionProvider();

    const result = await provider.selectClips({
      sermonId: transcript.sermonId,
      transcript,
      prompt: clipSelectionPromptV2
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.output.clips[0]?.promptVersion).toBe("clip-selection-v2");
    expect(result.value.output.clips[0]?.id).toContain("focused");
  });

  it("uses caption-ranked hooks for the v3 prompt", async () => {
    const provider = createDeterministicClipSelectionProvider();

    const result = await provider.selectClips({
      sermonId: transcript.sermonId,
      transcript,
      prompt: clipSelectionPromptV3
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.output.clips[0]?.promptVersion).toBe("clip-selection-v3");
    expect(result.value.output.clips[0]?.id).toContain("caption_ranked");
    expect(result.value.output.clips[0]?.hook).toContain("You");
  });
});

const transcript = {
  sermonId: "sermon_model_test",
  language: "en",
  segments: [
    {
      startSeconds: 10,
      endSeconds: 60,
      text: "Some of us are tired, and grace meets us with mercy. Jesus invites burdened people to come honestly and receive rest."
    }
  ]
};
