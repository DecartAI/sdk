import type { Model } from "../shared/model";
import { createSDKError, ERROR_CODES } from "../utils/errors";

/**
 * Client-token claims mapped to SDK names. Trusted when returned by `verifyClientToken` /
 * `client.tokens.verify`; UNTRUSTED when returned by `decodeClientToken` / `client.tokens.decode`.
 */
export type ClientTokenClaims = {
  /** `metadata.service_tier` at mint time (`0` is the free tier); `null` when unset. */
  serviceTier: number | null;
  /** `"free"` when `serviceTier` is `0`, otherwise `"paid"`. */
  pool: "free" | "paid";
  /** `sub` — the owning user (the organization owner for org tokens). */
  userId: string;
  organizationId: string | null;
  apiKeyName: string | null;
  /** Parent permanent key id when present, else the ephemeral key's own id (`jti`). */
  apiKeyId: string | null;
  /** `null` = unrestricted. */
  allowedModels: (Model | (string & {}))[] | null;
  /** `null` = unrestricted. */
  allowedOrigins: string[] | null;
  /** ISO 8601, like `CreateTokenResponse.expiresAt`. */
  expiresAt: string;
  /** `null` when the owning key is exempt from the limit. */
  realtimeConcurrentSessionLimit: number | null;
  zeroDataRetention: boolean;
  attribution: Record<string, string> | null;
  /** The full JWT payload, for anything not mapped above. */
  raw: Record<string, unknown>;
};

/** JOSE header prefix plus three segments; opaque `ek_*` / `dct_*` keys never match. */
export const isClientTokenJwt = (credential: string) =>
  typeof credential === "string" && credential.startsWith("eyJ") && credential.split(".").length === 3;

const invalid = (message: string, data?: Record<string, unknown>) =>
  createSDKError(ERROR_CODES.TOKEN_INVALID, `Invalid client token: ${message}`, data);

/** An integer (not a boolean) or an integer string, else `null`. */
const parseServiceTier = (raw: unknown) =>
  typeof raw === "number" && Number.isInteger(raw)
    ? raw
    : typeof raw === "string" && /^\s*[+-]?\d+\s*$/.test(raw)
      ? Number.parseInt(raw, 10)
      : null;
const str = (value: unknown) => (typeof value === "string" ? value : null);
const strArray = (value: unknown) =>
  Array.isArray(value) && value.every((item) => typeof item === "string") ? (value as string[]) : null;

/** Map a raw JWT payload to {@link ClientTokenClaims}. Requires `sub` and `exp`. */
export function mapClientTokenClaims(raw: Record<string, unknown>): ClientTokenClaims {
  if (typeof raw.sub !== "string" || !raw.sub) throw invalid("missing `sub` claim", { claim: "sub" });
  if (typeof raw.exp !== "number") throw invalid("missing `exp` claim", { claim: "exp" });
  // Legacy `metadata.priority: true` maps to tier 3 when `service_tier` is unset.
  const serviceTier = parseServiceTier(raw.service_tier) ?? (raw.priority ? 3 : null);
  const attribution = raw.attribution;
  return {
    serviceTier,
    pool: serviceTier === 0 ? "free" : "paid",
    userId: raw.sub,
    organizationId: str(raw.organizationId),
    apiKeyName: str(raw.api_key_name),
    apiKeyId: str(raw.parent_api_key_id) ?? str(raw.jti),
    allowedModels: strArray(raw.models),
    allowedOrigins: strArray(raw.origins),
    expiresAt: new Date(raw.exp * 1000).toISOString(),
    realtimeConcurrentSessionLimit:
      typeof raw.realtimeConcurrentSessionLimit === "number" ? raw.realtimeConcurrentSessionLimit : null,
    zeroDataRetention: raw.zeroDataRetention === true,
    attribution:
      typeof attribution === "object" && attribution !== null && !Array.isArray(attribution)
        ? (attribution as Record<string, string>)
        : null,
    raw,
  };
}

/**
 * Read a client token's claims WITHOUT verifying it — no network, no crypto, so it works everywhere
 * including React Native. The result is UNTRUSTED: use it for display or logging, never for
 * authorization (use `verifyClientToken` / `client.tokens.verify` for that).
 *
 * @throws `TOKEN_INVALID` when the string is not a JWT or the payload is malformed.
 */
export function decodeClientToken(token: string): ClientTokenClaims {
  if (!isClientTokenJwt(token)) throw invalid("not a JWT", { reason: "malformed" });
  let payload: unknown;
  try {
    const base64 = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    // Percent-encode each byte so decodeURIComponent reassembles UTF-8 (no TextDecoder/Buffer needed).
    const utf8 = atob(base64).replace(/[\s\S]/g, (c) => `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
    payload = JSON.parse(decodeURIComponent(utf8));
  } catch {
    throw invalid("payload is not base64url JSON", { reason: "malformed" });
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw invalid("payload is not a JSON object", { reason: "malformed" });
  }
  return mapClientTokenClaims(payload as Record<string, unknown>);
}
