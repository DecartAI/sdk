import type { ModelDefinition } from "../shared/model";
import { buildAuthHeaders, buildFormData } from "../shared/request";
import { createQueueResultError, createQueueStatusError, createQueueSubmitError } from "../utils/errors";
import type { JobStatusResponse, JobSubmitResponse } from "./types";

export type QueueRequestOptions = {
  baseUrl: string;
  apiKey: string;
  integration?: string;
};

/**
 * Submit a job to the queue.
 * POST /v1/jobs/{model}
 */
export async function submitJob({
  baseUrl,
  apiKey,
  model,
  inputs,
  signal,
  integration,
}: QueueRequestOptions & {
  model: ModelDefinition;
  inputs: Record<string, unknown>;
  signal?: AbortSignal;
  proxy?: boolean;
}): Promise<JobSubmitResponse> {
  const formData = buildFormData(inputs);

  if (!model.queueUrlPath) {
    throw createQueueSubmitError(`Model ${model.name} does not support queue processing`, 400);
  }

  const endpoint = `${baseUrl}${model.queueUrlPath}`;
  const headers = buildAuthHeaders({ apiKey, integration });

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: formData,
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unknown error");
    throw createQueueSubmitError(`Failed to submit job: ${response.status} - ${errorText}`, response.status);
  }

  return response.json() as Promise<JobSubmitResponse>;
}

/**
 * Get the status of a job.
 * GET /v1/jobs/{job_id}
 */
export async function getJobStatus({
  baseUrl,
  apiKey,
  jobId,
  signal,
  integration,
  proxy = false,
}: QueueRequestOptions & {
  jobId: string;
  signal?: AbortSignal;
  proxy?: boolean;
}): Promise<JobStatusResponse> {
  const endpoint = `${baseUrl}/v1/jobs/${jobId}`;
  const headers = buildAuthHeaders({ apiKey: proxy ? undefined : apiKey, integration });

  const response = await fetch(endpoint, {
    method: "GET",
    headers,
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unknown error");
    throw createQueueStatusError(`Failed to get job status: ${response.status} - ${errorText}`, response.status);
  }

  return response.json() as Promise<JobStatusResponse>;
}

/**
 * Get the content/result of a completed job.
 * GET /v1/jobs/{job_id}/content
 */
export async function getJobContent({
  baseUrl,
  apiKey,
  jobId,
  signal,
  integration,
  proxy = false,
}: QueueRequestOptions & {
  jobId: string;
  signal?: AbortSignal;
  proxy?: boolean;
}): Promise<Blob> {
  const endpoint = `${baseUrl}/v1/jobs/${jobId}/content`;
  const headers = buildAuthHeaders({ apiKey: proxy ? undefined : apiKey, integration });

  const response = await fetch(endpoint, {
    method: "GET",
    headers,
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unknown error");
    throw createQueueResultError(`Failed to get job content: ${response.status} - ${errorText}`, response.status);
  }

  return response.blob();
}
