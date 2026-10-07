import { createDecartClient } from "@decartai/sdk";
import { NextResponse } from "next/server";

const DECART_API_KEY = process.env.DECART_API_KEY;

/**
 * Mints a short-lived client token with the permanent API key, which never leaves the server.
 * The browser's `apiKeyProvider` calls this right before every realtime connect and reconnect.
 */
export async function POST() {
  try {
    if (!DECART_API_KEY) {
      return NextResponse.json({ error: "DECART_API_KEY is not set" }, { status: 500 });
    }

    const client = createDecartClient({ apiKey: DECART_API_KEY });
    const token = await client.tokens.create({
      // Seconds until the token expires (1-3600, default 60). The SDK asks for a token right before
      // each dial, so a short TTL is enough; raise it only if you mint ahead of connecting.
      expiresIn: 60,
    });

    return NextResponse.json(token);
  } catch (error) {
    console.error("Failed to create client token:", error);
    return NextResponse.json({ error: "Failed to create client token" }, { status: 500 });
  }
}
