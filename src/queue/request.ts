import type { ModelDefinition } from "../shared/model";
import { buildAuthHeaders, buildFormData } from "../shared/request";
import {
	createQueueSubmitError,
	createQueueStatusError,
	createQueueResultError,
} from "../utils/errors";
import type { JobSubmitResponse, JobStatusResponse } from "./types";

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
}): Promise<JobSubmitResponse> {
	const formData = buildFormData(inputs);

	// Queue endpoint uses /v1/jobs/{model-name} pattern
	const endpoint = `${baseUrl}/v1/jobs/${model.name}`;
	const response = await fetch(endpoint, {
		method: "POST",
		headers: buildAuthHeaders(apiKey, integration),
		body: formData,
		signal,
	});

	if (!response.ok) {
		const errorText = await response.text().catch(() => "Unknown error");
		throw createQueueSubmitError(
			`Failed to submit job: ${response.status} - ${errorText}`,
			response.status,
		);
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
}: QueueRequestOptions & {
	jobId: string;
	signal?: AbortSignal;
}): Promise<JobStatusResponse> {
	const endpoint = `${baseUrl}/v1/jobs/${jobId}`;
	const response = await fetch(endpoint, {
		method: "GET",
		headers: buildAuthHeaders(apiKey, integration),
		signal,
	});

	if (!response.ok) {
		const errorText = await response.text().catch(() => "Unknown error");
		throw createQueueStatusError(
			`Failed to get job status: ${response.status} - ${errorText}`,
			response.status,
		);
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
}: QueueRequestOptions & {
	jobId: string;
	signal?: AbortSignal;
}): Promise<Blob> {
	const endpoint = `${baseUrl}/v1/jobs/${jobId}/content`;
	const response = await fetch(endpoint, {
		method: "GET",
		headers: buildAuthHeaders(apiKey, integration),
		signal,
	});

	if (!response.ok) {
		const errorText = await response.text().catch(() => "Unknown error");
		throw createQueueResultError(
			`Failed to get job content: ${response.status} - ${errorText}`,
			response.status,
		);
	}

	return response.blob();
}
