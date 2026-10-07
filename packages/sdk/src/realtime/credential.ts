import { decodeClientToken } from "../tokens/claims";
import { createApiKeyProviderResultError, createClientTokenExpiredError } from "../utils/errors";
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

/**
 * Refuse a client token the server is certain to refuse: a JWT whose `exp` is already in the past,
 * beyond the clock-skew tolerance. Opaque keys and JWTs that do not decode pass through for the
 * server to judge.
 *
 * @throws `TOKEN_EXPIRED`
 */
export function assertClientTokenNotExpired(credential: string, now = Date.now()): void {
  let expiresAt: string;
  try {
    ({ expiresAt } = decodeClientToken(credential));
  } catch {
    return;
  }
  const expiredSecondsAgo = (now - Date.parse(expiresAt)) / 1000;
  if (expiredSecondsAgo > REALTIME_CONFIG.session.clientTokenExpiryToleranceSeconds) {
    throw createClientTokenExpiredError(Math.round(expiredSecondsAgo), expiresAt);
  }
}

/**
 * The per-dial credential: the provider's fresh token when one is set, else the static key, checked
 * for expiry either way. Synchronous for a static key, so the first socket still opens in the same
 * tick as `connect()`. Provider rejections propagate as they are.
 */
export function createCredentialSource(options: { apiKey: string; apiKeyProvider?: ApiKeyProvider }): ApiKeyProvider {
  const { apiKey, apiKeyProvider } = options;
  if (!apiKeyProvider) {
    return () => {
      assertClientTokenNotExpired(apiKey);
      return apiKey;
    };
  }
  return async () => {
    const credential: unknown = await apiKeyProvider();
    if (typeof credential !== "string" || credential.length === 0) throw createApiKeyProviderResultError(credential);
    assertClientTokenNotExpired(credential);
    return credential;
  };
}
