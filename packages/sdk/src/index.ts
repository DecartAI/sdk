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
  isImageModel,
  isRealtimeModel,
  isVideoModel,
  type Model,
  type ModelDefinition,
  models,
  type RealTimeModels,
  type VideoModelDefinition,
  type VideoModels,
} from "./shared/model";
export type { ModelState } from "./shared/types";
export type { CreateTokenResponse, TokensClient } from "./tokens/client";
export { type DecartSDKError, ERROR_CODES } from "./utils/errors";

// Schema with validation to ensure proxy and apiKey are mutually exclusive
// Proxy can be a full URL or a relative path (starts with /)
const proxySchema = z.union([z.string().url(), z.string().startsWith("/")]);

const decartClientOptionsSchema = z
  .object({
    apiKey: z.string().min(1).optional(),
    baseUrl: z.url().optional(),
    proxy: proxySchema.optional(),
    integration: z.string().optional(),
  })
  .refine(
    (data) => {
      // Must provide either proxy OR apiKey (or neither, which will use env var)
      // But cannot provide both
      const hasProxy = !!data.proxy;
      const hasApiKey = !!data.apiKey;
      return !(hasProxy && hasApiKey);
    },
    {
      message:
        "Cannot provide both 'proxy' and 'apiKey'. Use 'proxy' for proxy mode or 'apiKey' for direct API access.",
    },
  );

// Type-safe options: proxy mode or direct mode
export type DecartClientOptions =
  | {
      proxy: string;
      apiKey?: never;
      baseUrl?: string;
      integration?: string;
    }
  | {
      proxy?: never;
      apiKey?: string;
      baseUrl?: string;
      integration?: string;
    };

/**
 * Create a Decart API client.
 *
 * @param options - Configuration options
 * @param options.proxy - URL of the proxy server. When set, the client will use the proxy instead of direct API access and apiKey is not required.
 * @param options.apiKey - API key for authentication.
 * @param options.baseUrl - Override the default API base URL.
 * @param options.integration - Optional integration identifier.
 *
 * @example
 * ```ts
 * //  (direct API access)Option 1: Explicit API key
 * const client = createDecartClient({ apiKey: "your-api-key" });
 *
 * // Option 2: Using DECART_API_KEY environment variable
 * const client = createDecartClient();
 *
 * // Option 3: Using proxy (client-side, no API key needed)
 * const client = createDecartClient({ proxy: "https://your-server.com/api/decart" });
 * ```
 */
export const createDecartClient = (options: DecartClientOptions = {}) => {
  // Validate the options schema
  const parsedOptions = decartClientOptionsSchema.safeParse(options);

  if (!parsedOptions.success) {
    const issue = parsedOptions.error.issues[0];

    if (issue.path.includes("baseUrl")) {
      throw createInvalidBaseUrlError(
        issue.path.includes("baseUrl") ? (options as { baseUrl?: string }).baseUrl : undefined,
      );
    }

    if (issue.path.includes("proxy")) {
      throw createInvalidBaseUrlError(issue.path.includes("proxy") ? (options as { proxy?: string }).proxy : undefined);
    }

    // The schema refinement will catch mutual exclusivity issues
    throw parsedOptions.error;
  }

  const isProxyMode = "proxy" in parsedOptions.data && !!parsedOptions.data.proxy;

  // In proxy mode, apiKey is not required
  // In direct mode, apiKey is required (either provided or from env)
  const apiKey = isProxyMode
    ? undefined
    : (("apiKey" in parsedOptions.data ? parsedOptions.data.apiKey : undefined) ?? readEnv("DECART_API_KEY"));

  if (!isProxyMode && !apiKey) {
    throw createInvalidApiKeyError();
  }

  // Use proxy as baseUrl if provided, otherwise use default or provided baseUrl
  let baseUrl: string;
  if (isProxyMode && "proxy" in parsedOptions.data && parsedOptions.data.proxy) {
    baseUrl = parsedOptions.data.proxy;
  } else {
    baseUrl = parsedOptions.data.baseUrl || "https://api.decart.ai";
  }
  const { integration } = parsedOptions.data;

  // Realtime (WebRTC) always requires direct API access with API key
  // Proxy mode is only for HTTP endpoints (process, queue, tokens)
  // Note: Realtime will fail at connection time if no API key is provided
  const wsBaseUrl = "wss://api3.decart.ai";
  const realtime = createRealTimeClient({
    baseUrl: wsBaseUrl,
    apiKey: apiKey || "",
    integration,
  });

  const process = createProcessClient({
    baseUrl,
    apiKey: apiKey || "",
    integration,
    proxy: isProxyMode,
  });

  const queue = createQueueClient({
    baseUrl,
    apiKey: apiKey || "",
    integration,
    proxy: isProxyMode,
  });

  const tokens = createTokensClient({
    baseUrl,
    apiKey: apiKey || "",
    integration,
    proxy: isProxyMode,
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
