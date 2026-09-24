import { afterEach, describe, expect, it, vi } from "vitest";

// Proves realtime-only consumers never pay for jose: importing the SDK, creating a client and
// decoding a token must not evaluate it; only the first verify may.
const joseMock = vi.hoisted(() => ({ evaluations: 0, jwtVerify: vi.fn() }));

vi.mock("jose", () => {
  joseMock.evaluations++;
  class JOSEError extends Error {}
  return {
    jwtVerify: joseMock.jwtVerify,
    createRemoteJWKSet: vi.fn(() => vi.fn()),
    errors: { JOSEError, JWTExpired: class extends JOSEError {} },
  };
});

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const TOKEN = `${b64({ alg: "EdDSA", kid: "k1" })}.${b64({ sub: "user_1", exp: 4102444800, service_tier: 0 })}.sig`;

describe("jose is loaded lazily", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("rejects without WebCrypto (e.g. React Native) before loading jose", async () => {
    const { verifyClientToken } = await import("../src/index.js");
    vi.stubGlobal("crypto", {});
    await expect(verifyClientToken(TOKEN)).rejects.toMatchObject({ code: "UNSUPPORTED_PLATFORM_FEATURE" });
    expect(joseMock.evaluations).toBe(0);
  });

  it("is not evaluated on import, client creation or decode — only on the first verify", async () => {
    const sdk = await import("../src/index.js");
    const client = sdk.createDecartClient({ apiKey: "test" });
    expect(sdk.decodeClientToken(TOKEN).pool).toBe("free");
    expect(client.tokens.decode(TOKEN).userId).toBe("user_1");
    expect(joseMock.evaluations).toBe(0);

    joseMock.jwtVerify.mockResolvedValue({ payload: { sub: "user_1", exp: 4102444800, service_tier: 0 } });
    await client.tokens.verify(TOKEN);
    expect(joseMock.evaluations).toBe(1);
    expect(joseMock.jwtVerify).toHaveBeenCalledWith(
      TOKEN,
      expect.any(Function),
      expect.objectContaining({
        algorithms: ["EdDSA"],
        issuer: "https://platform.decart.ai",
        audience: "https://platform.decart.ai",
      }),
    );
  });
});
