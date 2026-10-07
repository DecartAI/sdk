import { describe, expect, it, vi } from "vitest";

import { REALTIME_CONFIG } from "../src/realtime/config-realtime.js";
import { assertClientTokenNotExpired, createCredentialSource } from "../src/realtime/credential.js";
import { DecartSDKException, ERROR_CODES } from "../src/utils/errors.js";

const base64url = (text: string) => btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
/** An unsigned JWT in the platform's client-token shape; only `exp` matters here. */
const clientTokenJwt = (claims: Record<string, unknown>) =>
  `eyJhbGciOiJFZERTQSJ9.${base64url(JSON.stringify({ sub: "user_1", ...claims }))}.sig`;

const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);
const expIn = (seconds: number) => Math.floor(NOW / 1000) + seconds;
const tolerance = REALTIME_CONFIG.session.clientTokenExpiryToleranceSeconds;

describe("assertClientTokenNotExpired", () => {
  it("passes opaque keys and JWTs it cannot decode through to the server", () => {
    expect(() => assertClientTokenNotExpired("ek_opaque", NOW)).not.toThrow();
    expect(() => assertClientTokenNotExpired("dct_permanent", NOW)).not.toThrow();
    expect(() => assertClientTokenNotExpired("eyJ.not-base64-json.sig", NOW)).not.toThrow();
    // A JWT with no `exp` is malformed for a client token; the server judges it.
    expect(() => assertClientTokenNotExpired(clientTokenJwt({ exp: undefined }), NOW)).not.toThrow();
  });

  it("passes a live token and one within the clock-skew tolerance", () => {
    expect(() => assertClientTokenNotExpired(clientTokenJwt({ exp: expIn(300) }), NOW)).not.toThrow();
    expect(() => assertClientTokenNotExpired(clientTokenJwt({ exp: expIn(0) }), NOW)).not.toThrow();
    expect(() => assertClientTokenNotExpired(clientTokenJwt({ exp: expIn(-tolerance) }), NOW)).not.toThrow();
  });

  it("rejects a token past the tolerance with TOKEN_EXPIRED and says how late it is", () => {
    const exp = expIn(-(tolerance + 1));
    let thrown: unknown;
    try {
      assertClientTokenNotExpired(clientTokenJwt({ exp }), NOW);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DecartSDKException);
    const { sdkError } = thrown as DecartSDKException;
    expect(sdkError.code).toBe(ERROR_CODES.TOKEN_EXPIRED);
    expect(sdkError.message).toContain(`Client token expired ${tolerance + 1} s ago`);
    expect(sdkError.message).toContain("apiKeyProvider");
    expect(sdkError.message).toContain("60 s");
    expect(sdkError.data).toEqual({
      claim: "exp",
      expiresAt: new Date(exp * 1000).toISOString(),
      expiredSecondsAgo: tolerance + 1,
    });
  });

  it("reports whole seconds for tokens hours late", () => {
    const exp = expIn(-7200);
    expect(() => assertClientTokenNotExpired(clientTokenJwt({ exp }), NOW + 400)).toThrow(
      expect.objectContaining({
        sdkError: expect.objectContaining({ data: expect.objectContaining({ expiredSecondsAgo: 7200 }) }),
      }),
    );
  });
});

describe("createCredentialSource", () => {
  it("returns the static key synchronously on every call without a provider", () => {
    const next = createCredentialSource({ apiKey: "ek_static" });
    expect(next()).toBe("ek_static");
    expect(next()).toBe("ek_static");
  });

  it("asks the provider on every call and prefers it over the static key", async () => {
    const provider = vi.fn().mockResolvedValueOnce("fresh-1").mockResolvedValueOnce("fresh-2");
    const next = createCredentialSource({ apiKey: "stale", apiKeyProvider: provider });

    await expect(next()).resolves.toBe("fresh-1");
    await expect(next()).resolves.toBe("fresh-2");
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it("accepts a synchronous provider", async () => {
    const next = createCredentialSource({ apiKey: "", apiKeyProvider: () => "sync-token" });
    await expect(next()).resolves.toBe("sync-token");
  });

  it("checks expiry on provider tokens and static tokens alike", async () => {
    const expired = clientTokenJwt({ exp: Math.floor(Date.now() / 1000) - 120 });
    expect(() => createCredentialSource({ apiKey: expired })()).toThrow(
      expect.objectContaining({ sdkError: expect.objectContaining({ code: ERROR_CODES.TOKEN_EXPIRED }) }),
    );
    await expect(createCredentialSource({ apiKey: "", apiKeyProvider: async () => expired })()).rejects.toMatchObject({
      sdkError: { code: ERROR_CODES.TOKEN_EXPIRED },
    });
  });

  it("rejects a provider result that is not a non-empty string", async () => {
    for (const result of ["", undefined, 42, { apiKey: "eyJ" }] as unknown[]) {
      const next = createCredentialSource({ apiKey: "", apiKeyProvider: async () => result as string });
      await expect(next()).rejects.toMatchObject({ sdkError: { code: ERROR_CODES.INVALID_API_KEY } });
    }
    const next = createCredentialSource({
      apiKey: "",
      apiKeyProvider: async () => ({ apiKey: "x" }) as unknown as string,
    });
    await expect(next()).rejects.toThrow("got object");
  });

  it("rethrows a provider Error as-is and wraps anything else so the retry loop sees an Error", async () => {
    const failure = new TypeError("Failed to fetch");
    await expect(createCredentialSource({ apiKey: "", apiKeyProvider: () => Promise.reject(failure) })()).rejects.toBe(
      failure,
    );

    await expect(
      createCredentialSource({ apiKey: "", apiKeyProvider: () => Promise.reject("endpoint down") })(),
    ).rejects.toThrow("apiKeyProvider rejected: endpoint down");

    const sdkError = { code: ERROR_CODES.TOKEN_CREATE_ERROR, message: "Failed to create token: 503" };
    const thrown = await createCredentialSource({ apiKey: "", apiKeyProvider: () => Promise.reject(sdkError) })().catch(
      (e: unknown) => e,
    );
    expect(thrown).toBeInstanceOf(DecartSDKException);
    expect((thrown as DecartSDKException).sdkError).toBe(sdkError);
  });
});
