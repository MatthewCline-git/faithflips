import { err, ok, type Result } from "@faithflips/core";
import { z } from "zod";

export const putObjectInputSchema = z.object({
  key: z.string().min(1),
  filePath: z.string().min(1),
  contentType: z.string().min(1)
});

export const storedObjectSchema = z.object({
  key: z.string().min(1),
  url: z.url(),
  contentType: z.string().min(1)
});

export type PutObjectInput = z.infer<typeof putObjectInputSchema>;
export type StoredObject = z.infer<typeof storedObjectSchema>;

export type StorageError =
  | {
      readonly type: "invalid_storage_input";
      readonly key?: string;
      readonly issues: readonly string[];
    }
  | {
      readonly type: "storage_upload_failed";
      readonly key: string;
      readonly message: string;
    };

export type StorageClient = {
  putObject(input: PutObjectInput): Promise<Result<StoredObject, StorageError>>;
};

export function createDeterministicStorageClient(input?: {
  readonly publicBaseUrl?: string;
  readonly failKeys?: readonly string[];
}): StorageClient {
  const publicBaseUrl = (input?.publicBaseUrl ?? "https://assets.example.test").replace(/\/$/, "");
  const failKeys = new Set(input?.failKeys ?? []);

  return {
    putObject(objectInput) {
      const parsedInput = putObjectInputSchema.safeParse(objectInput);
      if (!parsedInput.success) {
        return Promise.resolve(
          err({
            type: "invalid_storage_input",
            key: objectInput.key,
            issues: parsedInput.error.issues.map(
              (issue) => `${issue.path.join(".")}: ${issue.message}`
            )
          })
        );
      }

      if (failKeys.has(parsedInput.data.key)) {
        return Promise.resolve(
          err({
            type: "storage_upload_failed",
            key: parsedInput.data.key,
            message: "Deterministic storage failure"
          })
        );
      }

      return Promise.resolve(
        ok({
          key: parsedInput.data.key,
          url: `${publicBaseUrl}/${encodePathKey(parsedInput.data.key)}`,
          contentType: parsedInput.data.contentType
        })
      );
    }
  };
}

function encodePathKey(key: string): string {
  return key
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}
