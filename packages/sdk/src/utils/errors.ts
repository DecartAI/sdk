import type { RealtimeWebSocketErrorMessage, RealtimeWebSocketErrorType, ServerError } from "../realtime/types";

export type DecartSDKError = {
  code: string;
  message: string;
  data?: Record<string, unknown>;
  cause?: Error;
};

export type RealtimeServerErrorData = {
  errorType?: RealtimeWebSocketErrorType;
  serverPayload?: RealtimeWebSocketErrorMessage;
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
  // Realtime server error codes
  REALTIME_INVALID_API_KEY: "REALTIME_INVALID_API_KEY",
  REALTIME_ORIGIN_NOT_ALLOWED: "REALTIME_ORIGIN_NOT_ALLOWED",
  REALTIME_INVALID_MODEL: "REALTIME_INVALID_MODEL",
  REALTIME_REMOVED_MODEL: "REALTIME_REMOVED_MODEL",
  REALTIME_MODEL_NOT_AVAILABLE_FOR_TRIAL: "REALTIME_MODEL_NOT_AVAILABLE_FOR_TRIAL",
  REALTIME_INSUFFICIENT_CREDITS: "REALTIME_INSUFFICIENT_CREDITS",
  REALTIME_UPSTREAM_CAPACITY: "REALTIME_UPSTREAM_CAPACITY",
  REALTIME_UPSTREAM_REJECTED: "REALTIME_UPSTREAM_REJECTED",
  REALTIME_UPSTREAM_TIMEOUT: "REALTIME_UPSTREAM_TIMEOUT",
  REALTIME_MODEL_SERVER_DISCONNECTED: "REALTIME_MODEL_SERVER_DISCONNECTED",
  REALTIME_MODEL_SETUP_TIMEOUT: "REALTIME_MODEL_SETUP_TIMEOUT",
  REALTIME_SESSION_DURATION_LIMIT: "REALTIME_SESSION_DURATION_LIMIT",
  REALTIME_SESSION_NOT_FOUND: "REALTIME_SESSION_NOT_FOUND",
  REALTIME_SERVER_SHUTDOWN: "REALTIME_SERVER_SHUTDOWN",
  REALTIME_MODERATION_VIOLATION: "REALTIME_MODERATION_VIOLATION",
  REALTIME_INTERNAL_ERROR: "REALTIME_INTERNAL_ERROR",
} as const;

const REALTIME_SERVER_ERROR_CODES = {
  invalid_api_key: ERROR_CODES.REALTIME_INVALID_API_KEY,
  origin_not_allowed: ERROR_CODES.REALTIME_ORIGIN_NOT_ALLOWED,
  invalid_model: ERROR_CODES.REALTIME_INVALID_MODEL,
  removed_model: ERROR_CODES.REALTIME_REMOVED_MODEL,
  model_not_available_for_trial: ERROR_CODES.REALTIME_MODEL_NOT_AVAILABLE_FOR_TRIAL,
  insufficient_credits: ERROR_CODES.REALTIME_INSUFFICIENT_CREDITS,
  upstream_capacity: ERROR_CODES.REALTIME_UPSTREAM_CAPACITY,
  upstream_rejected: ERROR_CODES.REALTIME_UPSTREAM_REJECTED,
  upstream_timeout: ERROR_CODES.REALTIME_UPSTREAM_TIMEOUT,
  model_server_disconnected: ERROR_CODES.REALTIME_MODEL_SERVER_DISCONNECTED,
  model_setup_timeout: ERROR_CODES.REALTIME_MODEL_SETUP_TIMEOUT,
  session_duration_limit: ERROR_CODES.REALTIME_SESSION_DURATION_LIMIT,
  session_not_found: ERROR_CODES.REALTIME_SESSION_NOT_FOUND,
  server_shutdown: ERROR_CODES.REALTIME_SERVER_SHUTDOWN,
  moderation_violation: ERROR_CODES.REALTIME_MODERATION_VIOLATION,
  internal_error: ERROR_CODES.REALTIME_INTERNAL_ERROR,
} as const satisfies Record<RealtimeWebSocketErrorType, (typeof ERROR_CODES)[keyof typeof ERROR_CODES]>;

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

export function createWebrtcServerError(
  message: string,
  data?: RealtimeServerErrorData,
  cause?: Error,
): DecartSDKError {
  const code = data?.errorType ? REALTIME_SERVER_ERROR_CODES[data.errorType] : ERROR_CODES.WEBRTC_SERVER_ERROR;
  return createSDKError(code, message, data, cause);
}

export function createWebrtcSignalingError(error: Error): DecartSDKError {
  return createSDKError(ERROR_CODES.WEBRTC_SIGNALING_ERROR, "Signaling error", undefined, error);
}

/**
 * Classify a raw WebRTC error into a specific SDK error based on its message.
 */
export function classifyWebrtcError(error: Error): DecartSDKError {
  const msg = error.message.toLowerCase();
  const serverError = error as ServerError;
  const source = serverError.source;

  if (source === "server") {
    const data: RealtimeServerErrorData = {};
    if (serverError.errorType) data.errorType = serverError.errorType;
    if (serverError.serverPayload) data.serverPayload = serverError.serverPayload;
    return createWebrtcServerError(error.message, Object.keys(data).length > 0 ? data : undefined, error);
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
