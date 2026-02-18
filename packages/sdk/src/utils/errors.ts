export type DecartSDKError = {
  code: string;
  message: string;
  data?: Record<string, unknown>;
  cause?: Error;
};

export const ERROR_CODES = {
  INVALID_API_KEY: "INVALID_API_KEY",
  INVALID_BASE_URL: "INVALID_BASE_URL",
  PROCESSING_ERROR: "PROCESSING_ERROR",
  INVALID_INPUT: "INVALID_INPUT",
  INVALID_OPTIONS: "INVALID_OPTIONS",
  MODEL_NOT_FOUND: "MODEL_NOT_FOUND",
  QUEUE_SUBMIT_ERROR: "QUEUE_SUBMIT_ERROR",
  QUEUE_STATUS_ERROR: "QUEUE_STATUS_ERROR",
  QUEUE_RESULT_ERROR: "QUEUE_RESULT_ERROR",
  JOB_NOT_COMPLETED: "JOB_NOT_COMPLETED",
  TOKEN_CREATE_ERROR: "TOKEN_CREATE_ERROR",
  // WebRTC-specific error codes
  WEBRTC_WEBSOCKET_ERROR: "WEBRTC_WEBSOCKET_ERROR",
  WEBRTC_ICE_ERROR: "WEBRTC_ICE_ERROR",
  WEBRTC_TIMEOUT_ERROR: "WEBRTC_TIMEOUT_ERROR",
  WEBRTC_SERVER_ERROR: "WEBRTC_SERVER_ERROR",
  WEBRTC_SIGNALING_ERROR: "WEBRTC_SIGNALING_ERROR",
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
    "Missing API key. Pass `apiKey` to createDecartClient() or set the DECART_API_KEY environment variable.",
  );
}

export function createInvalidBaseUrlError(url?: string): DecartSDKError {
  return createSDKError(ERROR_CODES.INVALID_BASE_URL, `Invalid base URL${url ? `: ${url}` : ""}`);
}

export function createWebrtcWebsocketError(error: Error): DecartSDKError {
  return createSDKError(ERROR_CODES.WEBRTC_WEBSOCKET_ERROR, "WebSocket connection failed", undefined, error);
}

export function createWebrtcIceError(error: Error): DecartSDKError {
  return createSDKError(ERROR_CODES.WEBRTC_ICE_ERROR, "ICE connection failed", undefined, error);
}

export function createWebrtcTimeoutError(phase: string, timeoutMs?: number, cause?: Error): DecartSDKError {
  const hasTimeout = typeof timeoutMs === "number" && Number.isFinite(timeoutMs);
  return createSDKError(
    ERROR_CODES.WEBRTC_TIMEOUT_ERROR,
    hasTimeout ? `${phase} timed out after ${timeoutMs}ms` : `${phase} timed out`,
    hasTimeout ? { phase, timeoutMs } : { phase },
    cause,
  );
}

export function createWebrtcServerError(message: string): DecartSDKError {
  return createSDKError(ERROR_CODES.WEBRTC_SERVER_ERROR, message);
}

export function createWebrtcSignalingError(error: Error): DecartSDKError {
  return createSDKError(ERROR_CODES.WEBRTC_SIGNALING_ERROR, "Signaling error", undefined, error);
}

/**
 * Classify a raw WebRTC error into a specific SDK error based on its message.
 */
export function classifyWebrtcError(error: Error): DecartSDKError {
  const msg = error.message.toLowerCase();
  const source = (error as Error & { source?: string }).source;

  if (source === "server") {
    return createWebrtcServerError(error.message);
  }

  if (msg.includes("websocket")) {
    return createWebrtcWebsocketError(error);
  }
  if (msg.includes("ice connection failed")) {
    return createWebrtcIceError(error);
  }
  if (msg.includes("timeout") || msg.includes("timed out")) {
    const timeoutMatch = msg.match(/(\d+)\s*ms/);
    const timeoutMs = timeoutMatch ? Number.parseInt(timeoutMatch[1], 10) : undefined;
    return createWebrtcTimeoutError("connection", timeoutMs, error);
  }
  // Default to signaling error for unclassified WebRTC errors
  return createWebrtcSignalingError(error);
}

export function createInvalidInputError(message: string): DecartSDKError {
  return createSDKError(ERROR_CODES.INVALID_INPUT, message);
}

export function createModelNotFoundError(model: string): DecartSDKError {
  return createSDKError(ERROR_CODES.MODEL_NOT_FOUND, `Model ${model} not found`);
}

export function createQueueSubmitError(message: string, status?: number): DecartSDKError {
  return createSDKError(ERROR_CODES.QUEUE_SUBMIT_ERROR, message, { status });
}

export function createQueueStatusError(message: string, status?: number): DecartSDKError {
  return createSDKError(ERROR_CODES.QUEUE_STATUS_ERROR, message, { status });
}

export function createQueueResultError(message: string, status?: number): DecartSDKError {
  return createSDKError(ERROR_CODES.QUEUE_RESULT_ERROR, message, { status });
}

export function createJobNotCompletedError(jobId: string, currentStatus: string): DecartSDKError {
  return createSDKError(
    ERROR_CODES.JOB_NOT_COMPLETED,
    `Cannot get content for job ${jobId} with status "${currentStatus}"`,
    { jobId, currentStatus },
  );
}
