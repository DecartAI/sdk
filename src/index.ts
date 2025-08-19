import { z } from "zod";
import { createProcessClient } from "./process/client";
import { createRealTimeClient } from "./realtime/client";
import {
	createInvalidApiKeyError,
	createInvalidBaseUrlError,
} from "./utils/errors";

export type { ProcessClient } from "./process/client";
export type { ProcessOptions, VideoInput } from "./process/types";
export type {
	RealTimeClient,
	RealTimeClientConnectOptions,
	RealTimeClientInitialState,
} from "./realtime/client";
export { ERROR_CODES, type MirageSDKError } from "./utils/errors";

const mirageClientOptionsSchema = z.object({
	apiKey: z.string().min(1),
	baseUrl: z.url().optional().default("https://bouncer.mirage.decart.ai"),
});

export type MirageClientOptions = z.infer<typeof mirageClientOptionsSchema>;

export const createMirageClient = (options: MirageClientOptions) => {
	const parsedOptions = mirageClientOptionsSchema.safeParse(options);

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

	const { baseUrl, apiKey } = parsedOptions.data;

	const wsBaseUrl = baseUrl
		.replace("https://", "wss://")
		.replace("http://", "ws://");
	const realtime = createRealTimeClient({
		baseUrl: wsBaseUrl,
		apiKey,
	});

	const process = createProcessClient({
		baseUrl,
		apiKey,
	});

	return {
		realtime,
		process,
	};
};
