import { createInvalidInputError, createMirageError } from "../utils/errors";
import type { ProcessOptions, ProcessResult, VideoInput } from "./types";

export async function videoInputToBlob(input: VideoInput): Promise<Blob> {
	if (input instanceof Blob || input instanceof File) {
		return input;
	}

	if (input instanceof ArrayBuffer) {
		return new Blob([input], { type: "video/mp4" });
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

export async function processVideo({
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
}): Promise<ProcessResult> {
	const formData = new FormData();
	formData.append("video", blob, "video.mp4");

	if (options.prompt?.text) {
		formData.append("prompt", options.prompt.text);
		formData.append("should_enrich", String(options.prompt.enrich ?? true));
	}

	if (options.mirror) {
		formData.append("mirror", String(options.mirror));
	}

	const endpoint = `${baseUrl}/process_video`;
	const response = await fetch(endpoint, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
		},
		body: formData,
		signal,
	});

	if (!response.ok) {
		const errorText = await response.text().catch(() => "Unknown error");
		throw createMirageError(
			"PROCESSING_ERROR",
			`Processing failed: ${response.status} - ${errorText}`,
		);
	}

	return response.json();
}
