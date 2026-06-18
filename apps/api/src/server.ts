import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse
} from "node:http";
import { extname, join, normalize, relative } from "node:path";
import { blurPadSpanSchema, submitSermonSchema } from "@faithflips/core";
import { z } from "zod";
import type { JobStore } from "./job-store.js";
import { createProcessingService, type ProcessingService } from "./processing-service.js";

export type ApiErrorResponse = {
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
};

const jsonBodySchema = z.record(z.string(), z.unknown());

const rerenderBodySchema = z
  .object({
    startSeconds: z.number().nonnegative(),
    endSeconds: z.number().positive()
  })
  .refine((body) => body.endSeconds > body.startSeconds, {
    message: "endSeconds must be greater than startSeconds",
    path: ["endSeconds"]
  });

const finalizeBodySchema = z.object({
  blurPadSpans: z.array(blurPadSpanSchema).default([])
});

const createRunBodySchema = z.object({
  clipCount: z.number().int().min(1).max(12).default(6)
});

export function createServer(input: {
  readonly store: JobStore;
  readonly dataDir: string;
  readonly publicBaseUrl: string;
  readonly logger?: (event: Record<string, unknown>) => void;
}) {
  const processing = createProcessingService({
    store: input.store,
    dataDir: input.dataDir,
    publicBaseUrl: input.publicBaseUrl,
    ...(input.logger ? { logger: input.logger } : {})
  });

  return createHttpServer((request, response) => {
    void handleRequest(request, response, processing, join(input.dataDir, "public"));
  });
}

export async function createApiResponse(input: {
  readonly method: string;
  readonly pathname: string;
  readonly body?: unknown;
  readonly processing: ProcessingService;
  readonly processJobsOnSubmit?: boolean;
}): Promise<{ readonly statusCode: number; readonly body: unknown }> {
  if (input.method === "GET" && input.pathname === "/health") {
    return { statusCode: 200, body: { ok: true } };
  }

  const videoRunMatch = /^\/videos\/([^/]+)\/runs\/(\d+)$/.exec(input.pathname);
  if (input.method === "GET" && videoRunMatch) {
    const youtubeContentId = decodeURIComponent(videoRunMatch[1] ?? "");
    const runNumber = Number(videoRunMatch[2]);
    const run = await input.processing.getRun(youtubeContentId, runNumber);
    if (!run.ok) {
      return {
        statusCode: 404,
        body: {
          error: {
            code: "job_not_found",
            message: "Run not found"
          }
        } satisfies ApiErrorResponse
      };
    }

    return { statusCode: 200, body: run.value };
  }

  const videoRunsMatch = /^\/videos\/([^/]+)\/runs$/.exec(input.pathname);
  if (input.method === "POST" && videoRunsMatch) {
    const youtubeContentId = decodeURIComponent(videoRunsMatch[1] ?? "");
    const parsedBody = createRunBodySchema.safeParse(input.body ?? {});
    if (!parsedBody.success) {
      return {
        statusCode: 400,
        body: {
          error: {
            code: "invalid_run_input",
            message: parsedBody.error.issues[0]?.message ?? "Invalid run input"
          }
        } satisfies ApiErrorResponse
      };
    }

    const accepted = await input.processing.createRun({
      youtubeContentId,
      clipCount: parsedBody.data.clipCount
    });
    if (!accepted.ok) {
      return {
        statusCode: 400,
        body: {
          error: {
            code: accepted.error.type,
            message: processingErrorMessage(accepted.error)
          }
        } satisfies ApiErrorResponse
      };
    }

    if (input.processJobsOnSubmit ?? true) {
      void input.processing.processJob(accepted.value.jobId);
    }
    return { statusCode: 202, body: accepted.value };
  }

  const jobMatch = /^\/jobs\/([^/]+)$/.exec(input.pathname);
  if (input.method === "GET" && jobMatch) {
    const jobId = decodeURIComponent(jobMatch[1] ?? "");
    const job = await input.processing.getJob(jobId);
    if (!job.ok) {
      return {
        statusCode: 404,
        body: {
          error: {
            code: "job_not_found",
            message: "Job not found"
          }
        } satisfies ApiErrorResponse
      };
    }

    return { statusCode: 200, body: job.value };
  }

  if (input.method === "POST" && input.pathname === "/sermons") {
    const submission = submitSermonSchema.safeParse(input.body);
    if (!submission.success) {
      return {
        statusCode: 400,
        body: {
          error: {
            code: "invalid_sermon_submission",
            message: submission.error.issues[0]?.message ?? "Invalid sermon submission"
          }
        } satisfies ApiErrorResponse
      };
    }

    const accepted = await input.processing.submit(submission.data);
    if (!accepted.ok) {
      return {
        statusCode: 400,
        body: {
          error: {
            code: accepted.error.type,
            message: processingErrorMessage(accepted.error)
          }
        } satisfies ApiErrorResponse
      };
    }

    if ((input.processJobsOnSubmit ?? true) && accepted.value.status === "queued") {
      void input.processing.processJob(accepted.value.jobId);
    }
    return { statusCode: 202, body: accepted.value };
  }

  const rerenderMatch = /^\/clips\/([^/]+)\/rerender$/.exec(input.pathname);
  if (input.method === "POST" && rerenderMatch) {
    const clipId = decodeURIComponent(rerenderMatch[1] ?? "");
    const parsedBody = rerenderBodySchema.safeParse(input.body);

    if (!parsedBody.success) {
      return {
        statusCode: 400,
        body: {
          error: {
            code: "invalid_rerender_input",
            message: parsedBody.error.issues[0]?.message ?? "Invalid re-render input"
          }
        } satisfies ApiErrorResponse
      };
    }

    const result = await input.processing.rerenderClip(clipId, parsedBody.data);
    if (!result.ok) {
      return {
        statusCode: 400,
        body: {
          error: {
            code: result.error.type,
            message: processingErrorMessage(result.error)
          }
        } satisfies ApiErrorResponse
      };
    }

    return { statusCode: 200, body: result.value };
  }

  const finalizeMatch = /^\/clips\/([^/]+)\/finalize$/.exec(input.pathname);
  if (input.method === "POST" && finalizeMatch) {
    const clipId = decodeURIComponent(finalizeMatch[1] ?? "");
    const parsedBody = finalizeBodySchema.safeParse(input.body);

    if (!parsedBody.success) {
      return {
        statusCode: 400,
        body: {
          error: {
            code: "invalid_finalize_input",
            message: parsedBody.error.issues[0]?.message ?? "Invalid finalize input"
          }
        } satisfies ApiErrorResponse
      };
    }

    const result = await input.processing.finalizeClip(clipId, parsedBody.data.blurPadSpans);
    if (!result.ok) {
      return {
        statusCode: 400,
        body: {
          error: {
            code: result.error.type,
            message: processingErrorMessage(result.error)
          }
        } satisfies ApiErrorResponse
      };
    }

    return { statusCode: 200, body: result.value };
  }

  return {
    statusCode: 404,
    body: {
      error: {
        code: "not_found",
        message: "Route not found"
      }
    } satisfies ApiErrorResponse
  };
}

function processingErrorMessage(error: {
  readonly type: string;
  readonly message?: string;
}): string {
  return error.message ?? error.type;
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  processing: ProcessingService,
  assetRoot: string
): Promise<void> {
  try {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Headers", "content-type");
    response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");

    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && url.pathname.startsWith("/assets/")) {
      await writeAsset(response, assetRoot, url.pathname);
      return;
    }

    const body = request.method === "POST" ? await readJsonBody(request) : undefined;
    const apiResponse =
      body === undefined
        ? await createApiResponse({
            method: request.method ?? "GET",
            pathname: url.pathname,
            processing
          })
        : await createApiResponse({
            method: request.method ?? "GET",
            pathname: url.pathname,
            body,
            processing
          });
    writeJson(response, apiResponse.statusCode, apiResponse.body);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown API failure";
    console.error(JSON.stringify({ event: "api_request_failed", message }));
    writeJson(response, 500, {
      error: {
        code: "internal_error",
        message: "Unexpected API failure"
      }
    } satisfies ApiErrorResponse);
  }
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {};
  }

  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return jsonBodySchema.parse(parsed);
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function writeAsset(
  response: ServerResponse,
  assetRoot: string,
  pathname: string
): Promise<void> {
  const key = decodeURIComponent(pathname.replace(/^\/assets\//, ""));
  const filePath = normalize(join(assetRoot, key));
  if (relative(assetRoot, filePath).startsWith("..")) {
    writeJson(response, 404, {
      error: { code: "not_found", message: "Asset not found" }
    } satisfies ApiErrorResponse);
    return;
  }

  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      throw new Error("Not a file");
    }

    response.writeHead(200, {
      "content-type": contentTypeForPath(filePath),
      "content-length": String(fileStat.size)
    });
    createReadStream(filePath).pipe(response);
  } catch {
    writeJson(response, 404, {
      error: { code: "not_found", message: "Asset not found" }
    } satisfies ApiErrorResponse);
  }
}

function contentTypeForPath(filePath: string): string {
  const extension = extname(filePath).toLowerCase();
  if (extension === ".mp4") {
    return "video/mp4";
  }
  if (extension === ".jpg" || extension === ".jpeg") {
    return "image/jpeg";
  }
  return "application/octet-stream";
}
