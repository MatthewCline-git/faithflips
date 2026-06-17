import { describe, expect, it } from "vitest";
import { createDeterministicStorageClient } from "./storage.js";

describe("createDeterministicStorageClient", () => {
  it("returns stable downloadable asset URLs", async () => {
    const storage = createDeterministicStorageClient({
      publicBaseUrl: "https://cdn.example.test/assets/"
    });

    const result = await storage.putObject({
      key: "renders/sermon 1/clip_1.mp4",
      filePath: "/tmp/clip_1.mp4",
      contentType: "video/mp4"
    });

    expect(result).toEqual({
      ok: true,
      value: {
        key: "renders/sermon 1/clip_1.mp4",
        url: "https://cdn.example.test/assets/renders/sermon%201/clip_1.mp4",
        contentType: "video/mp4"
      }
    });
  });

  it("returns typed upload failures", async () => {
    const storage = createDeterministicStorageClient({
      failKeys: ["renders/sermon_1/clip_1.mp4"]
    });

    const result = await storage.putObject({
      key: "renders/sermon_1/clip_1.mp4",
      filePath: "/tmp/clip_1.mp4",
      contentType: "video/mp4"
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("storage_upload_failed");
      expect(result.error.key).toBe("renders/sermon_1/clip_1.mp4");
    }
  });
});
