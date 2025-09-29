import { createInvalidInputError } from "../utils/errors";
import { fileInputToBlob, sendRequest } from "./request";
import { type ProcessOptions, processOptionsSchema } from "./types";

export type ProcessClient = (options: ProcessOptions) => Promise<Blob>;

export type ProcessClientOptions = {
	apiKey: string;
	baseUrl: string;
};

export const createProcessClient = (
	opts: ProcessClientOptions,
): ProcessClient => {
	const { apiKey, baseUrl } = opts;

	const _process = async (options: ProcessOptions): Promise<Blob> => {
		const parsedOptions = processOptionsSchema.safeParse(options);
		if (!parsedOptions.success) {
			throw createInvalidInputError(
				`Invalid process options: ${parsedOptions.error.message}`,
			);
		}

		const { model, file, prompt, signal, start, end } = parsedOptions.data;
		const fileBlob = file ? await fileInputToBlob(file) : undefined;
		const startBlob = start ? await fileInputToBlob(start) : undefined;
		const endBlob = end ? await fileInputToBlob(end) : undefined;

		const response = await sendRequest({
			baseUrl,
			apiKey,
			data: { model, prompt, file: fileBlob, start: startBlob, end: endBlob },
			signal,
		});

		return response;
	};

	return _process;
};
