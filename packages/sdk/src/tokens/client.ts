import { buildAuthHeaders } from "../shared/request";
import { createSDKError } from "../utils/errors";

export type TokensClientOptions = {
  baseUrl: string;
  apiKey: string;
  integration?: string;
};

export type CreateTokenResponse = {
  apiKey: string;
  expiresAt: string;
};

export type TokensClient = {
  /**
   * Create a client token.
   * @returns A short-lived API key safe for client-side use.
   * @example
   * ```ts
   * const client = createDecartClient({ apiKey: process.env.DECART_API_KEY });
   * const token = await client.tokens.create();
   * // Returns: { apiKey: "ek_...", expiresAt: "2024-12-15T12:10:00Z" }
   * ```
   */
  create: () => Promise<CreateTokenResponse>;
};

export const createTokensClient = (opts: TokensClientOptions): TokensClient => {
  const { baseUrl, apiKey, integration } = opts;

  const create = async (): Promise<CreateTokenResponse> => {
    const headers = buildAuthHeaders({ apiKey, integration });

    const response = await fetch(`${baseUrl}/v1/client/tokens`, {
      method: "POST",
      headers,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw createSDKError("TOKEN_CREATE_ERROR", `Failed to create token: ${response.status} - ${errorText}`, {
        status: response.status,
      });
    }

    return response.json();
  };

  return { create };
};
