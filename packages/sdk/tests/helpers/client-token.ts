const base64url = (text: string) => btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/**
 * An unsigned JWT in the platform's client-token shape (`apiKey` and `token` both carry it). Only
 * the payload matters to the SDK's expiry preflight; `sub` is required by the claims mapper.
 */
export const clientTokenJwt = (claims: Record<string, unknown>) =>
  `eyJhbGciOiJFZERTQSJ9.${base64url(JSON.stringify({ sub: "user_1", ...claims }))}.sig`;

/** An `exp` claim `seconds` away from `now` (milliseconds). */
export const expAt = (now: number, seconds: number) => Math.floor(now / 1000) + seconds;
