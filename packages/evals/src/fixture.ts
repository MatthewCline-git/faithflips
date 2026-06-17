import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { sermonSchema, transcriptSchema, type ClipCategory } from "@faithflips/core";
import { z } from "zod";

export const evalSermonMetadataSchema = sermonSchema.extend({
  audience: z.string().min(1).optional()
});

export const evalGoodMomentSchema = z
  .object({
    category: z.enum(["invitation", "encouragement", "teaching", "quote", "recap"]),
    startSeconds: z.number().nonnegative(),
    endSeconds: z.number().positive(),
    note: z.string().min(1)
  })
  .refine((moment) => moment.endSeconds > moment.startSeconds, {
    message: "Good moment must end after it starts",
    path: ["endSeconds"]
  });

export const evalLabelsSchema = z.object({
  goodMoments: z.array(evalGoodMomentSchema).default([])
});

export const evalFixtureSchema = z.object({
  id: z.string().min(1),
  metadata: evalSermonMetadataSchema,
  transcript: transcriptSchema,
  labels: evalLabelsSchema
});

export type EvalSermonMetadata = z.infer<typeof evalSermonMetadataSchema>;
export type EvalGoodMoment = z.infer<typeof evalGoodMomentSchema>;
export type EvalLabels = z.infer<typeof evalLabelsSchema>;
export type EvalFixture = z.infer<typeof evalFixtureSchema>;

export type FixtureReadError = {
  readonly code: "fixture_read_failed" | "fixture_invalid";
  readonly fixtureId?: string;
  readonly message: string;
};

export async function loadEvalFixtures(fixturesDir: string): Promise<readonly EvalFixture[]> {
  const entries = await readdir(fixturesDir, { withFileTypes: true });
  const fixtureIds = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  return Promise.all(fixtureIds.map((fixtureId) => loadEvalFixture(fixturesDir, fixtureId)));
}

export async function loadEvalFixture(
  fixturesDir: string,
  fixtureId: string
): Promise<EvalFixture> {
  const fixtureDir = join(fixturesDir, fixtureId);
  const metadata = evalSermonMetadataSchema.parse(
    await readJsonFile(join(fixtureDir, "metadata.json"))
  );
  const transcript = transcriptSchema.parse(
    await readJsonFile(join(fixtureDir, "transcript.json"))
  );
  const labels = evalLabelsSchema.parse(await readJsonFile(join(fixtureDir, "labels.json")));

  return evalFixtureSchema.parse({ id: fixtureId, metadata, transcript, labels });
}

export function categoryLabelCount(fixture: EvalFixture, category: ClipCategory): number {
  return fixture.labels.goodMoments.filter((moment) => moment.category === category).length;
}

async function readJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}
