import { createDecartClient } from "@decartai/sdk";
import { NextResponse } from "next/server";

const DECART_API_KEY = process.env.DECART_API_KEY;

export async function POST() {
  try {
    if (!DECART_API_KEY) {
      return NextResponse.json({ error: "DECART_API_KEY is not set" }, { status: 500 });
    }

    const client = createDecartClient({
      apiKey: DECART_API_KEY,
    });
    const token = await client.tokens.create();

    return NextResponse.json(token);
  } catch (error) {
    console.error("Failed to create client token:", error);
    return NextResponse.json({ error: "Failed to create client token" }, { status: 500 });
  }
}
