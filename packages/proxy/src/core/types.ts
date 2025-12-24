/**
 * Configuration options for the Decart proxy.
 */
export type DecartProxyOptions = {
  /**
   * API key to use for authenticating requests to api.decart.ai
   */
  apiKey: string;
  /**
   * Base URL for the Decart API. Defaults to "https://api.decart.ai"
   */
  baseUrl?: string;
  /**
   * Optional integration identifier to include in User-Agent header
   */
  integration?: string;
};
