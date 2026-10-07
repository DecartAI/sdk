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
  /** Client-token verification: the token is not a valid, correctly signed Decart client token. */
  TOKEN_INVALID: "TOKEN_INVALID",
  /** Client-token verification: signature is fine but `exp` is in the past (beyond clock tolerance). */
  TOKEN_EXPIRED: "TOKEN_EXPIRED",
  /** Client-token verification could not run, e.g. the JWKS could not be fetched. Says nothing about the token. */
  TOKEN_VERIFY_ERROR: "TOKEN_VERIFY_ERROR",
  FILES_UPLOAD_ERROR: "FILES_UPLOAD_ERROR",
  FILES_GET_ERROR: "FILES_GET_ERROR",
  FILES_DELETE_ERROR: "FILES_DELETE_ERROR",
  REACT_NATIVE_SETUP_REQUIRED: "REACT_NATIVE_SETUP_REQUIRED",
  UNSUPPORTED_PLATFORM_FEATURE: "UNSUPPORTED_PLATFORM_FEATURE",
  LIVEKIT_INITIALIZATION_ERROR: "LIVEKIT_INITIALIZATION_ERROR",
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

export function isDecartSDKError(error: unknown): error is DecartSDKError {
  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as Partial<DecartSDKError>).code === "string" &&
    typeof (error as Partial<DecartSDKError>).message === "string"
  );
}

/**
 * An `Error` carrying a {@link DecartSDKError} across the realtime session's retry loop, which
 * (like p-retry) only accepts real errors. `connect()` and `classifyWebrtcError` unwrap it, so
 * callers still receive the plain SDK error.
 */
export class DecartSDKException extends Error {
  readonly sdkError: DecartSDKError;

  constructor(sdkError: DecartSDKError) {
    super(sdkError.message);
    this.name = "DecartSDKException";
    this.sdkError = sdkError;
    if (sdkError.cause) this.cause = sdkError.cause;
  }
}

export function createInvalidApiKeyError(): DecartSDKError {
  return createSDKError(
    ERROR_CODES.INVALID_API_KEY,
    "Missing API key. Pass `apiKey` or `apiKeyProvider` to createDecartClient(), or set the DECART_API_KEY environment variable.",
  );
}

/** The platform's default client-token TTL (`tokens.create({ expiresIn })`), quoted in the expiry message. */
const CLIENT_TOKEN_DEFAULT_TTL_SECONDS = 60;

/** An expired client token caught by the realtime preflight, before any dial. */
export function createClientTokenExpiredError(expiredSecondsAgo: number, expiresAt: string): DecartSDKError {
  return createSDKError(
    ERROR_CODES.TOKEN_EXPIRED,
    `Client token expired ${expiredSecondsAgo} s ago (exp ${expiresAt}). Mint a new one right before connecting, or pass apiKeyProvider to createDecartClient so the SDK fetches a fresh token before every connect and reconnect. Client tokens expire ${CLIENT_TOKEN_DEFAULT_TTL_SECONDS} s after minting by default (tokens.create({ expiresIn })).`,
    { claim: "exp", expiresAt, expiredSecondsAgo },
  );
}

export function createApiKeyProviderResultError(received: unknown): DecartSDKError {
  const got = received === "" ? "an empty string" : typeof received;
  return createSDKError(
    ERROR_CODES.INVALID_API_KEY,
    `apiKeyProvider must resolve to a non-empty API key string (a client token's apiKey); got ${got}.`,
  );
}

export function createInvalidBaseUrlError(url?: string): DecartSDKError {
  return createSDKError(ERROR_CODES.INVALID_BASE_URL, `Invalid base URL${url ? `: ${url}` : ""}`);
}

export function createReactNativeSetupRequiredError(missing: string[]): DecartSDKError {
  return createSDKError(
    ERROR_CODES.REACT_NATIVE_SETUP_REQUIRED,
    "React Native realtime requires @livekit/react-native registerGlobals() before calling Decart realtime APIs.",
    { missing },
  );
}

export function createUnsupportedPlatformFeatureError(feature: string, platform: string): DecartSDKError {
  return createSDKError(ERROR_CODES.UNSUPPORTED_PLATFORM_FEATURE, `${feature} is not supported on ${platform}.`, {
    feature,
    platform,
  });
}

export function createLiveKitInitializationError(message: string, cause?: Error): DecartSDKError {
  return createSDKError(ERROR_CODES.LIVEKIT_INITIALIZATION_ERROR, message, undefined, cause);
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
  // Already judged by the SDK (e.g. an expired client token on reconnect): surface it unchanged.
  if (error instanceof DecartSDKException) return error.sdkError;

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
