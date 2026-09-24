import { createSDKError, ERROR_CODES } from "../utils/errors";
import { type ClientTokenClaims, isClientTokenJwt, mapClientTokenClaims } from "./claims";

// Client tokens are signed by the developer platform, so the JWKS, issuer and audience live on the
// platform origin — not on the API host (`https://api.decart.ai`, the SDK's `baseUrl`).
const PLATFORM_URL = "https://platform.decart.ai";

export type VerifyClientTokenOptions = {
  /** Default `https://platform.decart.ai/api/auth/jwks`. */
  jwksUrl?: string;
  /** Expected `iss`. Default `https://platform.decart.ai`. */
  issuer?: string;
  /** Expected `aud`. Default `https://platform.decart.ai`. */
  audience?: string;
  /** Allowed clock skew in seconds for `exp`. Default 60. */
  clockTolerance?: number;
};

type Jose = typeof import("jose");
// Loaded on first verify only, so bundlers code-split jose away from consumers who never verify.
let jose: Promise<Jose> | undefined;
// One remote JWKS per URL; jose caches keys in memory and refetches at most once per minute for unknown kids.
const jwkSets = new Map<string, ReturnType<Jose["createRemoteJWKSet"]>>();

/**
 * Verify a Decart client token OFFLINE and return its claims: EdDSA signature against the
 * platform's public JWKS (fetched once and cached), plus `exp` (with clock tolerance), `iss` and
 * `aud`. This is a local JWKS check, not an API call, and it needs no API key. Requires WebCrypto and `fetch` (Node 20+, Bun, Deno, browsers, Workers, Edge).
 *
 * @throws `TOKEN_INVALID` bad signature, wrong `iss`/`aud`, malformed token or unknown `kid`
 * @throws `TOKEN_EXPIRED` `exp` is in the past
 * @throws `TOKEN_VERIFY_ERROR` the JWKS could not be fetched — the token itself was not judged
 */
export async function verifyClientToken(
  token: string,
  options: VerifyClientTokenOptions = {},
): Promise<ClientTokenClaims> {
  if (!isClientTokenJwt(token)) {
    throw createSDKError(ERROR_CODES.TOKEN_INVALID, "Invalid client token: not a JWT", { reason: "malformed" });
  }
  const jwksUrl = options.jwksUrl ?? `${PLATFORM_URL}/api/auth/jwks`;
  if (!jose) jose = import("jose");
  const { jwtVerify, createRemoteJWKSet, errors } = await jose;
  let jwkSet = jwkSets.get(jwksUrl);
  if (!jwkSet) {
    jwkSet = createRemoteJWKSet(new URL(jwksUrl), { cooldownDuration: 60_000 });
    jwkSets.set(jwksUrl, jwkSet);
  }

  try {
    const { payload } = await jwtVerify(token, jwkSet, {
      algorithms: ["EdDSA"],
      issuer: options.issuer ?? PLATFORM_URL,
      audience: options.audience ?? PLATFORM_URL,
      clockTolerance: options.clockTolerance ?? 60,
      requiredClaims: ["exp", "sub"],
    });
    return mapClientTokenClaims(payload);
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    const { code = "unknown", claim } = (cause ?? {}) as { code?: string; claim?: string };
    const data = { reason: code, ...(claim ? { claim } : {}) };
    if (error instanceof errors.JWTExpired) {
      throw createSDKError(ERROR_CODES.TOKEN_EXPIRED, `Client token expired: ${cause?.message}`, data, cause);
    }
    // jose judged the token itself (signature, claims, shape, unknown kid) unless the JWKS fetch failed.
    const jwksFailure =
      !(error instanceof errors.JOSEError) || /^ERR_(JOSE_GENERIC|JWKS_INVALID|JWKS_TIMEOUT)$/.test(code);
    if (!jwksFailure) {
      throw createSDKError(ERROR_CODES.TOKEN_INVALID, `Invalid client token: ${cause?.message}`, data, cause);
    }
    throw createSDKError(
      ERROR_CODES.TOKEN_VERIFY_ERROR,
      `Could not load the client-token JWKS from ${jwksUrl}: ${cause?.message ?? String(error)}`,
      { ...data, jwksUrl },
      cause,
    );
  }
}
