export type DecartSDKError = {
	code: string;
	message: string;
	data?: Record<string, unknown>;
	cause?: Error;
};

export const ERROR_CODES = {
	INVALID_API_KEY: "INVALID_API_KEY",
	INVALID_BASE_URL: "INVALID_BASE_URL",
	WEB_RTC_ERROR: "WEB_RTC_ERROR",
	PROCESSING_ERROR: "PROCESSING_ERROR",
	INVALID_INPUT: "INVALID_INPUT",
	INVALID_OPTIONS: "INVALID_OPTIONS",
	MODEL_NOT_FOUND: "MODEL_NOT_FOUND",
} as const;

export function createSDKError(
	code: string,
	message: string,
	data?: Record<string, unknown>,
	cause?: Error,
): DecartSDKError {
	return { code, message, data, cause };
}

export function createInvalidApiKeyError(): DecartSDKError {
	return createSDKError(
		ERROR_CODES.INVALID_API_KEY,
		"API key is required and must be a non-empty string",
	);
}

export function createInvalidBaseUrlError(url?: string): DecartSDKError {
	return createSDKError(
		ERROR_CODES.INVALID_BASE_URL,
		`Invalid base URL${url ? `: ${url}` : ""}`,
	);
}

export function createWebrtcError(error: Error): DecartSDKError {
	return createSDKError(ERROR_CODES.WEB_RTC_ERROR, "WebRTC error", {
		cause: error,
	});
}

export function createInvalidInputError(message: string): DecartSDKError {
	return createSDKError(ERROR_CODES.INVALID_INPUT, message);
}

export function createModelNotFoundError(model: string): DecartSDKError {
	return createSDKError(
		ERROR_CODES.MODEL_NOT_FOUND,
		`Model ${model} not found`,
	);
}
