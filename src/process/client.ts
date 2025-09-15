import { createInvalidInputError } from "../utils/errors";
import {
	type ProcessOptions,
	processOptionsSchema,
	type VideoInput,
} from "./types";
import { processVideo, videoInputToBlob } from "./video";

export type ProcessClient = {
	video: (input: VideoInput, options: ProcessOptions) => Promise<Blob>;
};

export type ProcessClientOptions = {
	baseUrl: string;
};

export const createProcessClient = (
	opts: ProcessClientOptions,
): ProcessClient => {
	const { baseUrl } = opts;

	const video = async (
		input: VideoInput,
		options: ProcessOptions,
	): Promise<Blob> => {
		const parsedOptions = processOptionsSchema.safeParse(options);
		if (!parsedOptions.success) {
			// TODO: status code 400
			throw createInvalidInputError(
				`Invalid process options: ${parsedOptions.error.message}`,
			);
		}

		const { model, prompt, mirror, signal } = parsedOptions.data;

		const blob = await videoInputToBlob(input);
		const response = await processVideo({
			baseUrl,
			blob,
			options: { model, prompt, mirror },
			signal,
		});

		return response;
	};

	return {
		video,
	};
};
