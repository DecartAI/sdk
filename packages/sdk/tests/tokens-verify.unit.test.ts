import { exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDecartClient, decodeClientToken, ERROR_CODES, verifyClientToken } from "../src/index.js";

const PLATFORM = "https://platform.decart.ai";
const KID = "SKOrN3D6tdV4pu8OyOplVFMi9cGVxLgb";

// Claims with the wire names the platform signs into client tokens.
const MINTED_CLAIMS = {
  organizationId: "org_123",
  parent_api_key_id: "key_parent",
  api_key_name: "Production",
  models: ["lucy-2.5"],
  origins: ["https://example.com"],
  zeroDataRetention: true,
  realtimeConcurrentSessionLimit: 4,
  service_tier: 2,
  attribution: { campaign: "launch" },
};

const server = setupServer();
let jwksFetches = 0;
let signingKey: CryptoKey;
let attackerKey: CryptoKey;
let publicJwk: JWK;

type MintOptions = { key?: CryptoKey; kid?: string; issuer?: string; audience?: string; expiresIn?: number };

function mint(overrides: Record<string, unknown> = {}, options: MintOptions = {}): Promise<string> {
  const { key = signingKey, kid = KID, issuer = PLATFORM, audience = PLATFORM, expiresIn = 300 } = options;
  return new SignJWT({ ...MINTED_CLAIMS, ...overrides })
    .setProtectedHeader({ alg: "EdDSA", kid })
    .setSubject("user_owner")
    .setJti("ek_row_1")
    .setIssuer(issuer)
    .setAudience(audience)
    .setExpirationTime(Math.floor(Date.now() / 1000) + expiresIn)
    .sign(key);
}

beforeAll(async () => {
  const pair = await generateKeyPair("EdDSA", { extractable: true });
  signingKey = pair.privateKey;
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: KID, alg: "EdDSA" };
  attackerKey = (await generateKeyPair("EdDSA")).privateKey;
  server.listen({ onUnhandledRequest: "error" });
});

beforeEach(() => {
  jwksFetches = 0;
  server.use(
    http.get(`${PLATFORM}/api/auth/jwks`, () => {
      jwksFetches++;
      return HttpResponse.json({ keys: [publicJwk] });
    }),
  );
});

afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});

afterAll(() => server.close());

describe("verifyClientToken", () => {
  it("verifies a valid token against the platform JWKS and maps its claims", async () => {
    const claims = await verifyClientToken(await mint());

    expect(jwksFetches).toBe(1);
    expect(claims).toMatchObject({
      serviceTier: 2,
      pool: "paid",
      userId: "user_owner",
      organizationId: "org_123",
      apiKeyName: "Production",
      apiKeyId: "key_parent",
      allowedModels: ["lucy-2.5"],
      allowedOrigins: ["https://example.com"],
      realtimeConcurrentSessionLimit: 4,
      zeroDataRetention: true,
      attribution: { campaign: "launch" },
    });
    expect(claims.expiresAt).toBe(new Date((claims.raw.exp as number) * 1000).toISOString());
  });

  it("reuses the cached JWKS; tier 0 is the free pool and jti is the key id without a parent", async () => {
    const claims = await verifyClientToken(await mint({ service_tier: 0, parent_api_key_id: null }));
    expect(jwksFetches).toBe(0);
    expect(claims).toMatchObject({ serviceTier: 0, pool: "free", apiKeyId: "ek_row_1" });
  });

  it("rejects a tampered signature", async () => {
    await expect(verifyClientToken(await mint({ service_tier: 0 }, { key: attackerKey }))).rejects.toMatchObject({
      code: ERROR_CODES.TOKEN_INVALID,
      data: { reason: "ERR_JWS_SIGNATURE_VERIFICATION_FAILED" },
    });
  });

  it("rejects an expired token but tolerates clock skew", async () => {
    await expect(verifyClientToken(await mint({}, { expiresIn: -120 }))).rejects.toMatchObject({
      code: ERROR_CODES.TOKEN_EXPIRED,
    });
    await expect(verifyClientToken(await mint({}, { expiresIn: -30 }))).resolves.toBeDefined();
  });

  it("rejects a wrong issuer or audience", async () => {
    await expect(verifyClientToken(await mint({}, { issuer: "https://evil.example" }))).rejects.toMatchObject({
      code: ERROR_CODES.TOKEN_INVALID,
      data: { claim: "iss" },
    });
    await expect(verifyClientToken(await mint({}, { audience: "https://api.decart.ai" }))).rejects.toMatchObject({
      code: ERROR_CODES.TOKEN_INVALID,
      data: { claim: "aud" },
    });
  });

  it("reports a JWKS outage as TOKEN_VERIFY_ERROR instead of judging the token", async () => {
    const jwksUrl = "https://down.platform.example/api/auth/jwks";
    server.use(http.get(jwksUrl, () => HttpResponse.text("nope", { status: 503 })));
    await expect(verifyClientToken(await mint(), { jwksUrl })).rejects.toMatchObject({
      code: ERROR_CODES.TOKEN_VERIFY_ERROR,
    });
  });

  it("is exposed as client.tokens.verify / client.tokens.decode", async () => {
    const client = createDecartClient({ apiKey: "test-api-key" });
    const token = await mint();
    expect(await client.tokens.verify(token)).toEqual(await verifyClientToken(token));
    expect(client.tokens.decode(token)).toEqual(decodeClientToken(token));
  });
});

describe("decodeClientToken", () => {
  it("returns the mapped claims with no network and no verification", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const token = await mint({ attribution: { note: "héllo ✓" } }, { key: attackerKey, expiresIn: -3600 });

    const claims = decodeClientToken(token);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(claims).toMatchObject({ serviceTier: 2, userId: "user_owner", attribution: { note: "héllo ✓" } });
    expect(new Date(claims.expiresAt).getTime()).toBeLessThan(Date.now());
    expect(() => decodeClientToken("ek_abc")).toThrow(expect.objectContaining({ code: ERROR_CODES.TOKEN_INVALID }));
  });

  it("parses service_tier like the platform", async () => {
    expect(decodeClientToken(await mint({ service_tier: "3" })).serviceTier).toBe(3);
    expect(decodeClientToken(await mint({ service_tier: true })).serviceTier).toBeNull();
    expect(decodeClientToken(await mint({ service_tier: undefined })).pool).toBe("paid");
    expect(decodeClientToken(await mint({ service_tier: undefined, priority: true })).serviceTier).toBe(3);
  });
});
