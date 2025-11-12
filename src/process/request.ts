import type { ModelDefinition } from "../shared/model";
import { createInvalidInputError, createSDKError } from "../utils/errors";
import { buildUserAgent } from "../utils/user-agent";
import type { FileInput } from "./types";

export async function fileInputToBlob(input: FileInput): Promise<Blob> {
	if (input instanceof Blob || input instanceof File) {
		return input;
	}

	if (input instanceof ReadableStream) {
		const response = new Response(input);
		return response.blob();
	}

	if (typeof input === "string" || input instanceof URL) {
		const url = typeof input === "string" ? input : input.toString();

		if (!url.startsWith("http://") && !url.startsWith("https://")) {
			throw createInvalidInputError("URL must start with http:// or https://");
		}

		const response = await fetch(url);
		if (!response.ok) {
			throw createInvalidInputError(
				`Failed to fetch file from URL: ${response.statusText}`,
			);
		}
		return response.blob();
	}

	throw createInvalidInputError("Invalid file input type");
}

export async function sendRequest({
	baseUrl,
	apiKey,
	model,
	inputs,
	signal,
	integration,
}: {
	baseUrl: string;
	apiKey: string;
	model: ModelDefinition;
	inputs: Record<string, unknown>;
	signal?: AbortSignal;
	integration?: string;
}): Promise<Blob> {
	const formData = new FormData();

	for (const [key, value] of Object.entries(inputs)) {
		if (value !== undefined && value !== null) {
			if (value instanceof Blob) {
				formData.append(key, value);
			} else if (typeof value === "object" && value !== null) {
				formData.append(key, JSON.stringify(value) as string);
			} else {
				formData.append(key, String(value) as string);
			}
		}
	}

	const endpoint = `${baseUrl}${model.urlPath}`;
	const response = await fetch(endpoint, {
		method: "POST",
		headers: {
			"X-API-KEY": apiKey,
			"User-Agent": buildUserAgent(integration),
		},
		body: formData,
		signal,
	});

	if (!response.ok) {
		const errorText = await response.text().catch(() => "Unknown error");
		throw createSDKError(
			"PROCESSING_ERROR",
			`Processing failed: ${response.status} - ${errorText}`,
		);
	}

	return response.blob();
}
