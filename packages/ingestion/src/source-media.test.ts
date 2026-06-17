import { describe, expect, it } from "vitest";
import {
  createYouTubeSourceMediaClient,
  parseYouTubeVideoId,
  type FetchLike
} from "./source-media.js";

describe("parseYouTubeVideoId", () => {
  it("extracts ids from watch and short URLs", () => {
    expect(parseYouTubeVideoId("https://www.youtube.com/watch?v=abc123")).toEqual({
      ok: true,
      value: "abc123"
    });
    expect(parseYouTubeVideoId("https://youtu.be/xyz789")).toEqual({
      ok: true,
      value: "xyz789"
    });
  });

  it("returns typed errors for invalid YouTube URLs", () => {
    const result = parseYouTubeVideoId("https://example.com/watch?v=abc123");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("invalid_source_url");
    }
  });
});

describe("createYouTubeSourceMediaClient", () => {
  it("fetches and validates YouTube metadata", async () => {
    const fetch: FetchLike = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            title: "Sunday Sermon",
            author_name: "Grace Church",
            provider_name: "YouTube",
            thumbnail_url: "https://i.ytimg.com/vi/abc123/hqdefault.jpg"
          })
      });
    const client = createYouTubeSourceMediaClient({
      fetch,
      now: () => new Date("2026-01-01T00:00:00.000Z")
    });

    const result = await client.getMetadata({
      sourceUrl: "https://www.youtube.com/watch?v=abc123"
    });

    expect(result).toEqual({
      ok: true,
      value: {
        sourceType: "youtube_url",
        sourceUrl: "https://www.youtube.com/watch?v=abc123",
        videoId: "abc123",
        title: "Sunday Sermon",
        authorName: "Grace Church",
        providerName: "YouTube",
        thumbnailUrl: "https://i.ytimg.com/vi/abc123/hqdefault.jpg",
        fetchedAt: "2026-01-01T00:00:00.000Z"
      }
    });
  });

  it("returns typed errors when YouTube metadata is malformed", async () => {
    const fetch: FetchLike = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ title: "" })
      });
    const client = createYouTubeSourceMediaClient({ fetch });

    const result = await client.getMetadata({
      sourceUrl: "https://www.youtube.com/watch?v=abc123"
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("malformed_source_metadata");
    }
  });

  it("returns remote media references for YouTube assets", async () => {
    const fetch: FetchLike = () =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    const client = createYouTubeSourceMediaClient({ fetch });

    const result = await client.getMedia({
      sourceUrl: "https://youtu.be/xyz789"
    });

    expect(result).toEqual({
      ok: true,
      value: {
        sourceType: "youtube_url",
        sourceUrl: "https://youtu.be/xyz789",
        videoId: "xyz789",
        mediaUrl: "https://youtu.be/xyz789",
        access: "remote_reference"
      }
    });
  });
});
