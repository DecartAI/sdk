import type { FileInput } from "../process/types";
import type { VideoModelDefinition } from "../shared/model";
import { fileInputToBlob } from "../shared/request";
import { createInvalidInputError } from "../utils/errors";
import { pollUntilComplete } from "./polling";
import { getJobContent, getJobStatus, submitJob } from "./request";
import type {
  JobStatusResponse,
  JobSubmitResponse,
  QueueJobResult,
  QueueSubmitAndPollOptions,
  QueueSubmitOptions,
} from "./types";

/**
 * Client for queue-based async video generation.
 * Only video models support the queue API.
 */
export type QueueClient = {
  /**
   * Submit a job to the queue for async processing.
   * Returns immediately with job_id and initial status.
   *
   * @example
   * ```ts
   * const job = await client.queue.submit({
   *   model: models.video("lucy-pro-t2v"),
   *   prompt: "A cat playing piano"
   * });
   * console.log(job.job_id); // "job_abc123"
   * ```
   */
  submit: <T extends VideoModelDefinition>(options: QueueSubmitOptions<T>) => Promise<JobSubmitResponse>;

  /**
   * Get the current status of a job.
   *
   * @example
   * ```ts
   * const status = await client.queue.status("job_abc123");
   * console.log(status.status); // "pending" | "processing" | "completed" | "failed"
   * ```
   */
  status: (jobId: string) => Promise<JobStatusResponse>;

  /**
   * Get the result of a completed job.
   * Should only be called when job status is "completed".
   *
   * @example
   * ```ts
   * const blob = await client.queue.result("job_abc123");
   * videoElement.src = URL.createObjectURL(blob);
   * ```
   */
  result: (jobId: string) => Promise<Blob>;

  /**
   * Submit a job and automatically poll until completion.
   * Returns a result object with status (does not throw on failure).
   *
   * @example
   * ```ts
   * const result = await client.queue.submitAndPoll({
   *   model: models.video("lucy-pro-t2v"),
   *   prompt: "A beautiful sunset",
   *   onStatusChange: (job) => {
   *     console.log(`Job ${job.job_id}: ${job.status}`);
   *   }
   * });
   *
   * if (result.status === "completed") {
   *   videoElement.src = URL.createObjectURL(result.data);
   * } else {
   *   console.error("Job failed:", result.error);
   * }
   * ```
   */
  submitAndPoll: <T extends VideoModelDefinition>(options: QueueSubmitAndPollOptions<T>) => Promise<QueueJobResult>;
};

export type QueueClientOptions = {
  apiKey: string;
  baseUrl: string;
  integration?: string;
};

export const createQueueClient = (opts: QueueClientOptions): QueueClient => {
  const { apiKey, baseUrl, integration } = opts;

  const submit = async <T extends VideoModelDefinition>(options: QueueSubmitOptions<T>): Promise<JobSubmitResponse> => {
    const { model, signal, ...inputs } = options;

    // Validate inputs using model's Zod schema
    const parsedInputs = model.inputSchema.safeParse(inputs);
    if (!parsedInputs.success) {
      throw createInvalidInputError(`Invalid inputs for ${model.name}: ${parsedInputs.error.message}`);
    }

    // Process file inputs (convert URLs, streams, etc. to Blobs)
    const processedInputs: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parsedInputs.data as Record<string, unknown>)) {
      if (key === "data" || key === "start" || key === "end" || key === "reference_image") {
        processedInputs[key] = await fileInputToBlob(value as FileInput, key, model.maxFileSize);
      } else {
        processedInputs[key] = value;
      }
    }

    return submitJob({
      baseUrl,
      apiKey,
      model,
      inputs: processedInputs,
      signal,
      integration,
    });
  };

  const status = async (jobId: string): Promise<JobStatusResponse> => {
    return getJobStatus({
      baseUrl,
      apiKey,
      jobId,
      integration,
    });
  };

  const result = async (jobId: string): Promise<Blob> => {
    return getJobContent({
      baseUrl,
      apiKey,
      jobId,
      integration,
    });
  };

  const submitAndPoll = async <T extends VideoModelDefinition>(
    options: QueueSubmitAndPollOptions<T>,
  ): Promise<QueueJobResult> => {
    const { onStatusChange, signal, ...submitOptions } = options;

    // Submit the job
    const job = await submit(submitOptions as QueueSubmitOptions<T>);

    // Notify of initial status
    if (onStatusChange) {
      onStatusChange(job);
    }

    // Poll until complete
    return pollUntilComplete({
      checkStatus: () =>
        getJobStatus({
          baseUrl,
          apiKey,
          jobId: job.job_id,
          signal,
          integration,
        }),
      getContent: () =>
        getJobContent({
          baseUrl,
          apiKey,
          jobId: job.job_id,
          signal,
          integration,
        }),
      onStatusChange,
      signal,
    });
  };

  return {
    submit,
    status,
    result,
    submitAndPoll,
  };
};
