import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { generatedClipSchema, processingJobStatusSchema, sermonSchema } from "@faithflips/core";
import type { GeneratedClip, ProcessingJob, Sermon } from "@faithflips/core";
import { z } from "zod";

export const persistedJobRecordSchema = z.object({
  sermon: sermonSchema,
  job: z.object({
    id: z.string().min(1),
    sermonId: z.string().min(1),
    status: processingJobStatusSchema,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    failureReason: z.string().min(1).optional()
  }),
  clips: z.array(generatedClipSchema)
});

const persistedJobStoreSchema = z.object({
  jobs: z.array(persistedJobRecordSchema)
});

export type PersistedJobRecord = z.infer<typeof persistedJobRecordSchema>;

export type JobStore = {
  create(record: PersistedJobRecord): Promise<void>;
  update(record: PersistedJobRecord): Promise<void>;
  get(jobId: string): Promise<PersistedJobRecord | undefined>;
  list(): Promise<readonly PersistedJobRecord[]>;
};

export type WorkflowOutput = {
  readonly sermon: Sermon;
  readonly job: ProcessingJob;
  readonly clips: readonly GeneratedClip[];
};

export function createFileJobStore(input: { readonly filePath: string }): JobStore {
  return {
    async create(record) {
      const store = await readStore(input.filePath);
      await writeStore(input.filePath, { jobs: upsertRecord(store.jobs, record) });
    },
    async update(record) {
      const store = await readStore(input.filePath);
      const existingIndex = store.jobs.findIndex((job) => job.job.id === record.job.id);
      const jobs =
        existingIndex === -1
          ? [...store.jobs, record]
          : store.jobs.map((job, index) => (index === existingIndex ? record : job));
      await writeStore(input.filePath, { jobs });
    },
    async get(jobId) {
      const store = await readStore(input.filePath);
      return store.jobs.find((job) => job.job.id === jobId);
    },
    async list() {
      const store = await readStore(input.filePath);
      return store.jobs;
    }
  };
}

export function createMemoryJobStore(): JobStore {
  let records: readonly PersistedJobRecord[] = [];

  return {
    create(record) {
      records = upsertRecord(records, record);
      return Promise.resolve();
    },
    update(record) {
      const existingIndex = records.findIndex((job) => job.job.id === record.job.id);
      records =
        existingIndex === -1
          ? [...records, record]
          : records.map((job, index) => (index === existingIndex ? record : job));
      return Promise.resolve();
    },
    get(jobId) {
      return Promise.resolve(records.find((job) => job.job.id === jobId));
    },
    list() {
      return Promise.resolve(records);
    }
  };
}

function upsertRecord(
  records: readonly PersistedJobRecord[],
  record: PersistedJobRecord
): PersistedJobRecord[] {
  const existingIndex = records.findIndex((job) => job.job.id === record.job.id);
  return existingIndex === -1
    ? [...records, record]
    : records.map((job, index) => (index === existingIndex ? record : job));
}

async function readStore(filePath: string): Promise<z.infer<typeof persistedJobStoreSchema>> {
  try {
    const raw = await readFile(filePath, "utf8");
    return persistedJobStoreSchema.parse(JSON.parse(raw));
  } catch (error) {
    if (isMissingFileError(error)) {
      return { jobs: [] };
    }
    throw error;
  }
}

async function writeStore(
  filePath: string,
  store: z.infer<typeof persistedJobStoreSchema>
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(store, null, 2)}\n`);
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}
