import { z } from "zod";
import { createRealTimeClient } from "./realtime/client";
import {
	createInvalidApiKeyError,
	createInvalidBaseUrlError,
} from "./utils/errors";

export type { RealTimeClient } from "./realtime/client";
export { ERROR_CODES, type MirageSDKError } from "./utils/errors";

const mirageClientOptionsSchema = z.object({
	apiKey: z.string().min(1),
	baseUrl: z.url().optional(),
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

	const { baseUrl = "wss://bouncer.mirage.decart.ai", apiKey } =
		parsedOptions.data;

	const realtime = createRealTimeClient({
		baseUrl,
		apiKey,
	});

	return {
		realtime,
	};
};
