import type { ModelDefinition } from "../shared/model";
import { createInvalidInputError } from "../utils/errors";
import { fileInputToBlob } from "../shared/request";
import { sendRequest } from "./request";
import type { FileInput, ProcessOptions } from "./types";

export type ProcessClient = <T extends ModelDefinition>(
	options: ProcessOptions<T>,
) => Promise<Blob>;

export type ProcessClientOptions = {
	apiKey: string;
	baseUrl: string;
	integration?: string;
};

export const createProcessClient = (
	opts: ProcessClientOptions,
): ProcessClient => {
	const { apiKey, baseUrl, integration } = opts;

	const _process = async <T extends ModelDefinition>(
		options: ProcessOptions<T>,
	): Promise<Blob> => {
		const { model, signal, ...inputs } = options;

		const parsedInputs = model.inputSchema.safeParse(inputs);
		if (!parsedInputs.success) {
			throw createInvalidInputError(
				`Invalid inputs for ${model.name}: ${parsedInputs.error.message}`,
			);
		}

		const processedInputs: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(
			parsedInputs.data as Record<string, unknown>,
		)) {
			if (key === "data" || key === "start" || key === "end") {
				processedInputs[key] = await fileInputToBlob(value as FileInput);
			} else {
				processedInputs[key] = value;
			}
		}

		const response = await sendRequest({
			baseUrl,
			apiKey,
			model,
			inputs: processedInputs,
			signal,
			integration,
		});

		return response;
	};

	return _process;
};
