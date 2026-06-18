import { describe, expect, it } from "vitest";
import {
  clipSelectionPromptV1,
  clipSelectionPromptV2,
  clipSelectionPromptV3,
  clipSelectionPrompts
} from "./index.js";

describe("clip selection prompts", () => {
  it("keeps versioned prompt metadata explicit", () => {
    expect(clipSelectionPromptV1.version).toBe("clip-selection-v1");
    expect(clipSelectionPromptV1.messages).toHaveLength(2);
    expect(clipSelectionPromptV1.outputContract).toContain("clips array");
  });

  it("exports prompt variants for eval comparison", () => {
    expect(clipSelectionPromptV2.version).toBe("clip-selection-v2");
    expect(clipSelectionPromptV3.outputContract).toContain("conviction");
    expect(clipSelectionPrompts.map((prompt) => prompt.version)).toEqual([
      "clip-selection-v1",
      "clip-selection-v2",
      "clip-selection-v3"
    ]);
  });
});
