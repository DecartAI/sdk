/**
 * Configuration options for the Decart proxy.
 */
export type DecartProxyOptions = {
  /**
   * API key to use for authenticating requests to api.decart.ai
   * We recommend using the DECART_API_KEY environment variable instead.
   */
  apiKey?: string;
  /**
   * Base URL for the Decart API. Defaults to "https://api.decart.ai"
   */
  baseUrl?: string;
  /**
   * Optional integration identifier to include in User-Agent header
   */
  integration?: string;
};

export type HeaderValue = string | string[] | undefined | null;

export interface ProxyBehavior<ResponseType> {
  /**
   * Internal identifier for built-in adapters. Custom adapters should use
   * `integration` instead to identify themselves.
   */
  id?: string;

  /**
   * HTTP method of the incoming request (GET, POST, etc.)
   */
  method: string;

  /**
   * Optional API key for authenticating with the Decart API.
   * If not provided, falls back to the DECART_API_KEY environment variable.
   */
  apiKey?: string;

  /**
   * Optional base URL for the Decart API.
   * Defaults to "https://api.decart.ai"
   */
  baseUrl?: string;

  /**
   * Optional integration identifier included in the User-Agent header.
   */
  integration?: string;

  /**
   * Send an error response to the client.
   * Called when the proxy encounters an error (e.g., missing API key).
   *
   * @param status - HTTP status code
   * @param data - Error message or data to send
   * @returns The framework's response type
   */
  // biome-ignore lint/suspicious/noExplicitAny: data can be any type
  respondWith(status: number, data: string | any): ResponseType;

  /**
   * Forward the successful proxy response to the client.
   * Handle the response body as appropriate for your framework.
   *
   * @param response - The fetch Response from the Decart API
   * @returns Promise resolving to the framework's response type
   */
  sendResponse(response: Response): Promise<ResponseType>;

  /**
   * Get all request headers as a record.
   * Header names should be lowercase for consistent matching.
   *
   * @returns Record of header names to values
   */
  getHeaders(): Record<string, HeaderValue>;

  /**
   * Get a specific request header value.
   *
   * @param name - Header name
   * @returns The header value, or undefined if not present
   */
  getHeader(name: string): HeaderValue;

  /**
   * Set a response header to forward to the client.
   *
   * @param name - Header name
   * @param value - Header value
   */
  sendHeader(name: string, value: string): void;

  /**
   * Get the request body.
   * Return as ArrayBuffer to preserve binary data (e.g., for FormData/multipart).
   *
   * @returns Promise resolving to the request body, or undefined if no body
   */
  getRequestBody(): Promise<string | ArrayBuffer | undefined>;

  /**
   * Get the request path to proxy to the Decart API.
   * Should return the path after your proxy route (e.g., "/v1/generate/lucy-pro-t2i").
   *
   * @returns The request path
   */
  getRequestPath(): string;
}
