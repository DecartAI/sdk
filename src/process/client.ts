import { createInvalidInputError } from "../utils/errors";
import {
	type FileInput,
	type ProcessOptions,
	processOptionsSchema,
} from "./types";
import { process, videoInputToBlob } from "./video";

export type ProcessClient = {
	video: (input: FileInput, options: ProcessOptions) => Promise<Blob>;
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
		input: FileInput,
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
		const response = await process({
			baseUrl,
			apiKey,
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
