import { z } from "zod";
import { createProcessClient } from "./process/client";
import { createRealTimeClient } from "./realtime/client";
import {
	createInvalidApiKeyError,
	createInvalidBaseUrlError,
} from "./utils/errors";

export type { ProcessClient } from "./process/client";
export type { FileInput, ProcessOptions } from "./process/types";
export type {
	RealTimeClient,
	RealTimeClientConnectOptions,
	RealTimeClientInitialState,
} from "./realtime/client";
export {
	type ImageModels,
	type Model,
	type ModelDefinition,
	models,
	type RealTimeModels,
	type VideoModels,
} from "./shared/model";
export type { ModelState } from "./shared/types";
export { type DecartSDKError, ERROR_CODES } from "./utils/errors";

const decartClientOptionsSchema = z.object({
	apiKey: z.string().min(1),
	baseUrl: z.url().optional(),
	integration: z.string().optional(),
});

export type DecartClientOptions = z.infer<typeof decartClientOptionsSchema>;

export const createDecartClient = (options: DecartClientOptions) => {
	const parsedOptions = decartClientOptionsSchema.safeParse(options);

	if (!parsedOptions.success) {
		const issue = parsedOptions.error.issues[0];

		if (issue.path.includes("apiKey")) {
			throw createInvalidApiKeyError();
		}

		if (issue.path.includes("baseUrl")) {
			throw createInvalidBaseUrlError(options.baseUrl);
		}

		throw parsedOptions.error;
	}

	const { baseUrl = "https://api.decart.ai", apiKey, integration } = parsedOptions.data;

	const wsBaseUrl = "wss://api3.decart.ai";
	const realtime = createRealTimeClient({
		baseUrl: wsBaseUrl,
		apiKey,
		integration,
	});

	const process = createProcessClient({
		baseUrl,
		apiKey,
		integration,
	});

	return {
		realtime,
		/**
		 * Client for video and image generation.
		 *
		 * @example
		 * ```ts
		 * const client = createDecartClient({ apiKey: "your-api-key" });
		 * const result = await client.process({
		 *   model: models.video("lucy-pro-t2v"),
		 *   prompt: "A beautiful sunset over the ocean"
		 * });
		 * ```
		 */
		process,
	};
};
