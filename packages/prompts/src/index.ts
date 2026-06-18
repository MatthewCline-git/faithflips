export type PromptMessage = {
  readonly role: "system" | "user";
  readonly content: string;
};

export type ClipSelectionPrompt = {
  readonly id: string;
  readonly version: string;
  readonly description: string;
  readonly messages: readonly PromptMessage[];
  readonly outputContract: string;
};

export const clipSelectionPromptV1: ClipSelectionPrompt = {
  id: "clip-selection",
  version: "clip-selection-v1",
  description: "Select viral sermon moments with punchy hooks for short-form social clips.",
  outputContract:
    "Return a JSON object with a clips array. Each clip must include startSeconds, endSeconds, title, hook, rationale, postCaption, firstWords, lastWords, and confidence.",
  messages: [
    {
      role: "system",
      content:
        "You find viral clips from sermons. Think Alex Hormozi energy - direct, punchy, scroll-stopping. No generic church bulletin vibes."
    },
    {
      role: "user",
      content:
        "Find 6 moments that stop someone mid-scroll. Counterintuitive truths, raw emotional beats, practical wisdom. Hook must be direct and personal like 'If you're struggling with X, hear this' - never generic. Caption like a real person, not a brand. No hashtags. Include firstWords and lastWords to verify complete thoughts."
    }
  ]
};

export const clipSelectionPromptV2: ClipSelectionPrompt = {
  id: "clip-selection",
  version: "clip-selection-v2",
  description:
    "Select sermon clips with stronger opening hooks and stricter context safety for short-form social posts.",
  outputContract:
    "Return a JSON object with a clips array. Each clip must include startSeconds, endSeconds, title, hook, rationale, postCaption, firstWords, lastWords, and confidence. Clips should open at a complete thought and close with resolution.",
  messages: [
    {
      role: "system",
      content:
        "You find viral sermon clips. Direct, punchy hooks that stop the scroll. No generic inspirational fluff."
    },
    {
      role: "user",
      content:
        "Find the 6 strongest clips - counterintuitive truths, raw moments, practical wisdom. Hook must grab immediately: 'Nobody talks about this but...', 'If you're struggling with X...'. Caption like a person, not a brand. No hashtags. Include firstWords and lastWords to verify complete thoughts."
    }
  ]
};

export const clipSelectionPromptV3: ClipSelectionPrompt = {
  id: "clip-selection",
  version: "clip-selection-v3",
  description:
    "Select sermon clips and choose ranked direct-address captions from multiple psychological angles.",
  outputContract:
    "Return a JSON object with a clips array. Each clip must include startSeconds, endSeconds, title, hook, rationale, postCaption, firstWords, lastWords, and confidence. Generate conviction, curiosity, encouragement, challenge, and direct-quote caption angles before selecting the strongest hook and caption.",
  messages: [
    {
      role: "system",
      content:
        "You are a senior short-form Christian social editor. Your job is not to summarize sermons. Your job is to identify the psychological angle that makes a believer stop scrolling and watch while staying faithful to the transcript."
    },
    {
      role: "user",
      content:
        "Find the 6 strongest clips. For each clip, internally generate multiple caption angles: conviction, curiosity, encouragement, challenge, second-person direct address, and direct quote. Prefer specific second-person hooks and direct quotes over summaries. Choose the final hook and postCaption by ranking for scroll-stopping tension, shareability, clarity, conviction plus hope, and theological faithfulness. Maximum 2 lines. No emojis, hashtags, generic Christian phrases, or openers like 'In this sermon' or 'Pastor explains'."
    }
  ]
};

export const clipSelectionPrompts = [
  clipSelectionPromptV1,
  clipSelectionPromptV2,
  clipSelectionPromptV3
] as const;
