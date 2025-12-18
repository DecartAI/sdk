import { z } from "zod";
import { createProcessClient } from "./process/client";
import { createQueueClient } from "./queue/client";
import { createRealTimeClient } from "./realtime/client";
import { createTokensClient } from "./tokens/client";
import { readEnv } from "./utils/env";
import { createInvalidApiKeyError, createInvalidBaseUrlError } from "./utils/errors";

export type { ProcessClient } from "./process/client";
export type { FileInput, ProcessOptions } from "./process/types";
export type { QueueClient } from "./queue/client";
export type {
  JobStatus,
  JobStatusResponse,
  JobSubmitResponse,
  QueueJobResult,
  QueueSubmitAndPollOptions,
  QueueSubmitOptions,
} from "./queue/types";
export type {
  RealTimeClient,
  RealTimeClientConnectOptions,
  RealTimeClientInitialState,
} from "./realtime/client";
export {
  type ImageModelDefinition,
  type ImageModels,
  imageModels,
  type Model,
  type ModelDefinition,
  modelSchema,
  models,
  type RealTimeModels,
  type VideoModelDefinition,
  type VideoModels,
  videoModels,
} from "./shared/model";
export { type ModelState, modelStateSchema } from "./shared/types";
export type { CreateTokenResponse, TokensClient } from "./tokens/client";
export { type DecartSDKError, ERROR_CODES } from "./utils/errors";

const decartClientOptionsSchema = z.object({
  apiKey: z.string().min(1).optional(),
  baseUrl: z.url().optional(),
  integration: z.string().optional(),
});

export type DecartClientOptions = z.infer<typeof decartClientOptionsSchema>;

/**
 * Create a Decart API client.
 *
 * @param options - Configuration options
 * @param options.apiKey - API key for authentication. Defaults to the DECART_API_KEY environment variable.
 * @param options.baseUrl - Override the default API base URL.
 * @param options.integration - Optional integration identifier.
 *
 * @example
 * ```ts
 * // Option 1: Explicit API key
 * const client = createDecartClient({ apiKey: "your-api-key" });
 *
 * // Option 2: Using DECART_API_KEY environment variable
 * const client = createDecartClient();
 * ```
 */
export const createDecartClient = (options: DecartClientOptions = {}) => {
  const apiKey = options.apiKey ?? readEnv("DECART_API_KEY");

  if (!apiKey) {
    throw createInvalidApiKeyError();
  }

  const parsedOptions = decartClientOptionsSchema.safeParse({
    ...options,
    apiKey,
  });

  if (!parsedOptions.success) {
    const issue = parsedOptions.error.issues[0];

    if (issue.path.includes("baseUrl")) {
      throw createInvalidBaseUrlError(options.baseUrl);
    }

    throw parsedOptions.error;
  }

  const { baseUrl = "https://api.decart.ai", integration } = parsedOptions.data;

  const wsBaseUrl = "wss://api3.decart.ai";
  const realtime = createRealTimeClient({
    baseUrl: wsBaseUrl,
    apiKey,
    integration,
  });

  const process = createProcessClient({
    baseUrl,
    apiKey,
    integration,
  });

  const queue = createQueueClient({
    baseUrl,
    apiKey,
    integration,
  });

  const tokens = createTokensClient({
    baseUrl,
    apiKey,
    integration,
  });

  return {
    realtime,
    /**
     * Client for synchronous image generation.
     * Only image models support the sync/process API.
     *
     * @example
     * ```ts
     * const client = createDecartClient({ apiKey: "your-api-key" });
     * const result = await client.process({
     *   model: models.image("lucy-pro-t2i"),
     *   prompt: "A beautiful sunset over the ocean"
     * });
     * ```
     */
    process,
    /**
     * Client for queue-based async video generation.
     * Only video models support the queue API.
     * Jobs are submitted and processed asynchronously.
     *
     * @example
     * ```ts
     * const client = createDecartClient({ apiKey: "your-api-key" });
     *
     * // Option 1: Submit and poll automatically
     * const result = await client.queue.submitAndPoll({
     *   model: models.video("lucy-pro-t2v"),
     *   prompt: "A beautiful sunset over the ocean",
     *   onStatusChange: (job) => console.log(`Job ${job.job_id}: ${job.status}`)
     * });
     *
     * // Option 2: Submit and poll manually
     * const job = await client.queue.submit({
     *   model: models.video("lucy-pro-t2v"),
     *   prompt: "A beautiful sunset over the ocean"
     * });
     *
     * // Poll until completion
     * while (true) {
     *   const status = await client.queue.status(job.job_id);
     *   console.log(`Job ${status.job_id}: ${status.status}`);
     *
     *   if (status.status === "completed") {
     *     const blob = await client.queue.result(job.job_id);
     *     break;
     *   }
     *   if (status.status === "failed") {
     *     throw new Error("Job failed");
     *   }
     *   await new Promise(resolve => setTimeout(resolve, 1500));
     * }
     * ```
     */
    queue,
    /**
     * Client for creating client tokens.
     * Client tokens are short-lived API keys safe for client-side use.
     *
     * @example
     * ```ts
     * // Server-side: Create a client token
     * const serverClient = createDecartClient({ apiKey: process.env.DECART_API_KEY });
     * const token = await serverClient.tokens.create();
     * // Returns: { apiKey: "ek_...", expiresAt: "2024-12-15T12:10:00Z" }
     *
     * // Client-side: Use the client token
     * const client = createDecartClient({ apiKey: token.apiKey });
     * const realtimeClient = await client.realtime.connect(stream, options);
     * ```
     */
    tokens,
  };
};
