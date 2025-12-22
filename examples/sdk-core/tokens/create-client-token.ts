import { createDecartClient } from "@decartai/sdk";
import { run } from "../lib/run";

run(async () => {
  // Server-side: Create client token using API key
  const serverClient = createDecartClient({
    apiKey: process.env.DECART_API_KEY,
  });

  console.log("Creating client token...");

  const token = await serverClient.tokens.create();

  console.log("Token created successfully:");
  console.log(`  API Key: ${token.apiKey.slice(0, 10)}...`);
  console.log(`  Expires At: ${token.expiresAt}`);

  // Client-side: Use the client token
  // In a real app, you would send token.apiKey to the frontend
  // biome-ignore lint/correctness/noUnusedVariables: on purpose
  const clientSideClient = createDecartClient({
    apiKey: token.apiKey,
  });

  console.log("Client created with client token.");
  console.log("This token can now be used for realtime connections.");
});
