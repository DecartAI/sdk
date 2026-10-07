import { describe, expect, it, vi } from "vitest";

import { REALTIME_CONFIG } from "../src/realtime/config-realtime.js";
import { assertClientTokenNotExpired, createCredentialSource } from "../src/realtime/credential.js";
import { ERROR_CODES } from "../src/utils/errors.js";
import { clientTokenJwt, expAt } from "./helpers/client-token.js";

const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);
const expIn = (seconds: number) => expAt(NOW, seconds);
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

    expect(() => assertClientTokenNotExpired(clientTokenJwt({ exp }), NOW)).toThrow(
      expect.objectContaining({
        code: ERROR_CODES.TOKEN_EXPIRED,
        message: expect.stringMatching(/^Client token expired 6 s ago .*apiKeyProvider.*60 s/),
        data: { claim: "exp", expiresAt: new Date(exp * 1000).toISOString(), expiredSecondsAgo: tolerance + 1 },
      }),
    );
  });

  it("reports whole seconds for tokens hours late", () => {
    expect(() => assertClientTokenNotExpired(clientTokenJwt({ exp: expIn(-7200) }), NOW + 400)).toThrow(
      expect.objectContaining({ data: expect.objectContaining({ expiredSecondsAgo: 7200 }) }),
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
    const expired = clientTokenJwt({ exp: expAt(Date.now(), -120) });
    expect(() => createCredentialSource({ apiKey: expired })()).toThrow(
      expect.objectContaining({ code: ERROR_CODES.TOKEN_EXPIRED }),
    );
    await expect(createCredentialSource({ apiKey: "", apiKeyProvider: async () => expired })()).rejects.toMatchObject({
      code: ERROR_CODES.TOKEN_EXPIRED,
    });
  });

  it("rejects a provider result that is not a non-empty string", async () => {
    for (const result of ["", undefined, 42, { apiKey: "eyJ" }] as unknown[]) {
      const next = createCredentialSource({ apiKey: "", apiKeyProvider: async () => result as string });
      await expect(next()).rejects.toMatchObject({ code: ERROR_CODES.INVALID_API_KEY });
    }
    const next = createCredentialSource({
      apiKey: "",
      apiKeyProvider: async () => ({ apiKey: "x" }) as unknown as string,
    });
    await expect(next()).rejects.toMatchObject({ message: expect.stringContaining("got object") });
  });

  it("lets a provider rejection through unchanged, whatever its shape", async () => {
    for (const rejection of [
      new TypeError("Failed to fetch"),
      "endpoint down",
      { code: "TOKEN_CREATE_ERROR", message: "503" },
    ]) {
      const next = createCredentialSource({ apiKey: "", apiKeyProvider: () => Promise.reject(rejection) });
      await expect(next()).rejects.toBe(rejection);
    }
  });
});
