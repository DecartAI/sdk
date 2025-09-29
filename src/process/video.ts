import { createInvalidInputError, createSDKError } from "../utils/errors";
import type { FileInput, ProcessOptions } from "./types";

export async function videoInputToBlob(input: FileInput): Promise<Blob> {
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
				`Failed to fetch video from URL: ${response.statusText}`,
			);
		}
		return response.blob();
	}

	throw createInvalidInputError("Invalid video input type");
}

export async function process({
	baseUrl,
	apiKey,
	blob,
	options,
	signal,
}: {
	baseUrl: string;
	apiKey: string;
	blob: Blob;
	options: ProcessOptions;
	signal?: AbortSignal;
}): Promise<Blob> {
	const formData = new FormData();
	formData.append("data", blob);

	if (options.prompt?.text) {
		formData.append("prompt", options.prompt.text);
	}

	if (options.mirror) {
		formData.append("mirror", String(options.mirror));
	}

	const endpoint = `${baseUrl}${options.model.urlPath}`;
	const response = await fetch(endpoint, {
		method: "POST",
		headers: {
			"X-API-KEY": apiKey,
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
