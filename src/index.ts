import { z } from "zod";
import { createProcessClient } from "./process/client";
import { createRealTimeClient } from "./realtime/client";
import {
	createInvalidBaseUrlError,
} from "./utils/errors";

export type { ProcessClient } from "./process/client";
export type { ProcessOptions, VideoInput } from "./process/types";
export type {
	RealTimeClient,
	RealTimeClientConnectOptions,
	RealTimeClientInitialState,
} from "./realtime/client";
export { type Model, type ModelDefinition, models } from "./shared/model";
export type { ModelState } from "./shared/types";
export { type DecartSDKError, ERROR_CODES } from "./utils/errors";

const decartClientOptionsSchema = z.object({
	baseUrl: z.url().optional(),
});

export type DecartClientOptions = z.infer<typeof decartClientOptionsSchema>;

export const createDecartClient = (options: DecartClientOptions) => {
	const parsedOptions = decartClientOptionsSchema.safeParse(options);

	if (!parsedOptions.success) {
		const issue = parsedOptions.error.issues[0];

		if (issue.path.includes("baseUrl")) {
			throw createInvalidBaseUrlError(options.baseUrl);
		}

		throw parsedOptions.error;
	}

	const { baseUrl = "https://bouncer.mirage.decart.ai" } =
		parsedOptions.data;

	const wsBaseUrl = baseUrl
		.replace("https://", "wss://")
		.replace("http://", "ws://");
	const realtime = createRealTimeClient({
		baseUrl: wsBaseUrl,
	});

	const process = createProcessClient({
		baseUrl,
	});

	return {
		realtime,
		process,
	};
};
