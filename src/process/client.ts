import { createMirageError } from "../utils/errors";
import {
	type ProcessOptions,
	type ProcessResult,
	processOptionsSchema,
	type VideoInput,
} from "./types";
import { processVideo, videoInputToBlob } from "./video";

export type ProcessClient = {
	video: (
		input: VideoInput,
		options?: ProcessOptions,
	) => Promise<ProcessResult>;
};

export type ProcessClientOptions = {
	apiKey: string;
	baseUrl: string;
};

export const createProcessClient = (
	opts: ProcessClientOptions,
): ProcessClient => {
	const { apiKey, baseUrl } = opts;

	const video = async (
		input: VideoInput,
		options?: ProcessOptions,
	): Promise<ProcessResult> => {
		const parsedOptions = processOptionsSchema.safeParse(options);
		if (!parsedOptions.success) {
			// TODO: status code 400
			throw createMirageError(
				"INVALID_OPTIONS",
				`Invalid process options: ${parsedOptions.error.message}`,
			);
		}

		const { prompt, mirror, signal } = parsedOptions.data;

		const blob = await videoInputToBlob(input);
		const response = await processVideo({
			baseUrl,
			apiKey,
			blob,
			options: { prompt, mirror },
			signal,
		});

		return response;
	};

	return {
		video,
	};
};
