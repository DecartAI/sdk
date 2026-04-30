import { type Model } from "../shared/model";
import { buildAuthHeaders } from "../shared/request";
import { createSDKError } from "../utils/errors";

export type TokensClientOptions = {
  baseUrl: string;
  apiKey: string;
  integration?: string;
};

export type CreateTokenOptions = {
  /** Custom key-value pairs to attach to the client token. */
  metadata?: Record<string, unknown>;
  /** Seconds until the token expires (1-3600, default 60). */
  expiresIn?: number;
  /** Restrict which models this token can access (max 20 items). */
  allowedModels?: (Model | (string & {}))[];
  /**
   * Restrict which web origins this token can be used from (max 20 items).
   * Each entry must be a full origin including scheme, e.g. `https://example.com`.
   * Enforced on realtime sessions by matching the WebSocket `Origin` header
   * verbatim. Defense-in-depth — only effective for browser-based clients.
   */
  allowedOrigins?: string[];
  /** Operational limits for the token. */
  constraints?: { realtime?: { maxSessionDuration?: number } };
};

export type CreateTokenResponse = {
  apiKey: string;
  expiresAt: string;
  /** Present when `allowedModels` and/or `allowedOrigins` were set on the request. */
  permissions?: {
    models?: (Model | (string & {}))[];
    origins?: string[];
  } | null;
  /** Present when `constraints` was set on the request. */
  constraints?: { realtime?: { maxSessionDuration?: number } } | null;
};

export type TokensClient = {
  /**
   * Create a client token.
   * @param options - Optional configuration for the token.
   * @param options.metadata - Custom key-value pairs to attach to the token.
   * @returns A short-lived API key safe for client-side use.
   * @example
   * ```ts
   * const client = createDecartClient({ apiKey: process.env.DECART_API_KEY });
   * const token = await client.tokens.create();
   * // Returns: { apiKey: "ek_...", expiresAt: "2024-12-15T12:10:00Z" }
   *
   * // With metadata:
   * const token = await client.tokens.create({ metadata: { role: "viewer" } });
   *
   * // With expiry, model restrictions, origin restrictions, and constraints:
   * const token = await client.tokens.create({
   *   expiresIn: 300,
   *   allowedModels: ["lucy-pro-v2v", "lucy-restyle-v2v"],
   *   allowedOrigins: ["https://example.com"],
   *   constraints: { realtime: { maxSessionDuration: 120 } },
   * });
   * ```
   */
  create: (options?: CreateTokenOptions) => Promise<CreateTokenResponse>;
};

export const createTokensClient = (opts: TokensClientOptions): TokensClient => {
  const { baseUrl, apiKey, integration } = opts;

  const create = async (options?: CreateTokenOptions): Promise<CreateTokenResponse> => {
    const headers: HeadersInit = {
      ...buildAuthHeaders({ apiKey, integration }),
      "content-type": "application/json",
    };

    const response = await fetch(`${baseUrl}/v1/client/tokens`, {
      method: "POST",
      headers,
      body: JSON.stringify(options ?? {}),
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
