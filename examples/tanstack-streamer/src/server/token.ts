import { createDecartClient } from "@decartai/sdk";
import { createServerFn } from "@tanstack/react-start";

export const getClientToken = createServerFn().handler(async () => {
  const apiKey = process.env.DECART_API_KEY;
  if (!apiKey) {
    throw new Error("DECART_API_KEY environment variable is not set");
  }

  const client = createDecartClient({ apiKey });
  const token = await client.tokens.create();
  return { apiKey: token.apiKey };
});
