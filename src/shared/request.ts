import { createInvalidInputError } from "../utils/errors";
import { buildUserAgent } from "../utils/user-agent";
import type { FileInput } from "../process/types";

/**
 * Convert various file input types to a Blob.
 */
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

/**
 * Build common headers for API requests.
 */
export function buildAuthHeaders(
	apiKey: string,
	integration?: string,
): HeadersInit {
	return {
		"X-API-KEY": apiKey,
		"User-Agent": buildUserAgent(integration),
	};
}

/**
 * Build FormData from inputs object.
 */
export function buildFormData(inputs: Record<string, unknown>): FormData {
	const formData = new FormData();

	for (const [key, value] of Object.entries(inputs)) {
		if (value !== undefined && value !== null) {
			if (value instanceof Blob) {
				formData.append(key, value);
			} else if (typeof value === "object" && value !== null) {
				formData.append(key, JSON.stringify(value));
			} else {
				formData.append(key, String(value));
			}
		}
	}

	return formData;
}
