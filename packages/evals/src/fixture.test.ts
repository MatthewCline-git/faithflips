import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadEvalFixtures } from "./fixture.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("eval fixtures", () => {
  it("loads sample sermon fixtures from disk", async () => {
    const fixtures = await loadEvalFixtures(join(packageRoot, "fixtures"));

    expect(fixtures).toHaveLength(1);
    expect(fixtures[0]?.id).toBe("sermon-001");
    expect(fixtures[0]?.labels.goodMoments).toHaveLength(3);
  });
});
