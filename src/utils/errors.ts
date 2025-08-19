export type MirageSDKError = {
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
} as const;

export function createMirageError(
	code: string,
	message: string,
	data?: Record<string, unknown>,
	cause?: Error,
): MirageSDKError {
	return { code, message, data, cause };
}

export function createInvalidApiKeyError(): MirageSDKError {
	return createMirageError(
		ERROR_CODES.INVALID_API_KEY,
		"API key is required and must be a non-empty string",
	);
}

export function createInvalidBaseUrlError(url?: string): MirageSDKError {
	return createMirageError(
		ERROR_CODES.INVALID_BASE_URL,
		`Invalid base URL${url ? `: ${url}` : ""}`,
	);
}

export function createWebrtcError(error: Error): MirageSDKError {
	return createMirageError(ERROR_CODES.WEB_RTC_ERROR, "WebRTC error", {
		cause: error,
	});
}

export function createInvalidInputError(message: string): MirageSDKError {
	return createMirageError(ERROR_CODES.INVALID_INPUT, message);
}
