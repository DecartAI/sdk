import { decodeClientToken, isClientTokenJwt } from "../tokens/claims";
import {
  createApiKeyProviderResultError,
  createClientTokenExpiredError,
  DecartSDKException,
  isDecartSDKError,
} from "../utils/errors";
import { REALTIME_CONFIG } from "./config-realtime";

/**
 * Returns the credential for the next realtime dial: a client token's `apiKey` (minted on your
 * server with `client.tokens.create`) or a permanent key. The SDK calls it right before every
 * connect and reconnect, so each dial carries a token minted for it instead of one from page load.
 *
 * A rejection on `connect()` rejects the connect with the same error. During reconnects a
 * rejection is retried like any other dial failure.
 */
export type ApiKeyProvider = () => string | Promise<string>;

/** Resolves and validates the credential for one dial. Synchronous for a static key, so the first socket still opens in the same tick. */
export type CredentialSource = () => string | Promise<string>;

/**
 * Refuse a client token the server is certain to refuse: a JWT whose `exp` is already in the past,
 * beyond the clock-skew tolerance. Opaque keys and JWTs that do not decode pass through for the
 * server to judge.
 *
 * @throws `DecartSDKException` wrapping a TOKEN_EXPIRED error
 */
export function assertClientTokenNotExpired(credential: string, now = Date.now()): void {
  if (!isClientTokenJwt(credential)) return;
  let expiresAt: string;
  try {
    expiresAt = decodeClientToken(credential).expiresAt;
  } catch {
    return;
  }
  const expiredSecondsAgo = (now - Date.parse(expiresAt)) / 1000;
  if (!(expiredSecondsAgo > REALTIME_CONFIG.session.clientTokenExpiryToleranceSeconds)) return;
  throw new DecartSDKException(createClientTokenExpiredError(Math.round(expiredSecondsAgo), expiresAt));
}

function describeThrown(value: unknown): string {
  if (typeof value === "object" && value !== null && "message" in value) return String(value.message);
  return String(value);
}

/**
 * Build the per-dial credential source: the provider's fresh token when one is set, else the static
 * key, checked for expiry either way. Every thrown value is an `Error`, which the session's retry
 * loop requires; SDK errors travel as {@link DecartSDKException} and are never retried.
 */
export function createCredentialSource(options: { apiKey: string; apiKeyProvider?: ApiKeyProvider }): CredentialSource {
  const { apiKey, apiKeyProvider } = options;
  if (!apiKeyProvider) {
    return () => {
      assertClientTokenNotExpired(apiKey);
      return apiKey;
    };
  }
  return async () => {
    let credential: unknown;
    try {
      credential = await apiKeyProvider();
    } catch (error) {
      if (isDecartSDKError(error)) throw new DecartSDKException(error);
      if (error instanceof Error) throw error;
      throw new Error(`apiKeyProvider rejected: ${describeThrown(error)}`);
    }
    if (typeof credential !== "string" || credential.length === 0) {
      throw new DecartSDKException(createApiKeyProviderResultError(credential));
    }
    assertClientTokenNotExpired(credential);
    return credential;
  };
}
