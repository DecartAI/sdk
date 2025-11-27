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
	QUEUE_SUBMIT_ERROR: "QUEUE_SUBMIT_ERROR",
	QUEUE_STATUS_ERROR: "QUEUE_STATUS_ERROR",
	QUEUE_RESULT_ERROR: "QUEUE_RESULT_ERROR",
	JOB_NOT_COMPLETED: "JOB_NOT_COMPLETED",
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

export function createQueueSubmitError(
	message: string,
	status?: number,
): DecartSDKError {
	return createSDKError(ERROR_CODES.QUEUE_SUBMIT_ERROR, message, { status });
}

export function createQueueStatusError(
	message: string,
	status?: number,
): DecartSDKError {
	return createSDKError(ERROR_CODES.QUEUE_STATUS_ERROR, message, { status });
}

export function createQueueResultError(
	message: string,
	status?: number,
): DecartSDKError {
	return createSDKError(ERROR_CODES.QUEUE_RESULT_ERROR, message, { status });
}

export function createJobNotCompletedError(
	jobId: string,
	currentStatus: string,
): DecartSDKError {
	return createSDKError(
		ERROR_CODES.JOB_NOT_COMPLETED,
		`Cannot get content for job ${jobId} with status "${currentStatus}"`,
		{ jobId, currentStatus },
	);
}
