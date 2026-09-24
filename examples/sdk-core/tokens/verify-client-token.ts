import { createDecartClient, decodeClientToken, verifyClientToken } from "@decartai/sdk";
import { run } from "../lib/run";

run(async () => {
  // Server-side: mint a client token. `token` is the signed JWT.
  const client = createDecartClient({ apiKey: process.env.DECART_API_KEY });
  const { token } = await client.tokens.create({ expiresIn: 120, metadata: { service_tier: 0 } });
  if (!token) throw new Error("Platform did not return a JWT");

  // Server / edge: verify OFFLINE against the platform JWKS (no API key, no round-trip).
  const claims = await verifyClientToken(token); // same as client.tokens.verify(token)
  console.log(`user=${claims.userId} org=${claims.organizationId} tier=${claims.serviceTier} pool=${claims.pool}`);
  console.log(`expires=${claims.expiresAt} models=${claims.allowedModels ?? "any"}`);

  // Anywhere: read claims WITHOUT verifying. Untrusted — display/logging only.
  console.log(`decoded (unverified) tier=${decodeClientToken(token).serviceTier}`);
});
