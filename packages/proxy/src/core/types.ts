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
  id: string;
  method: string;
  // biome-ignore lint/suspicious/noExplicitAny: data can be any type
  respondWith(status: number, data: string | any): ResponseType;
  sendResponse(response: Response): Promise<ResponseType>;
  getHeaders(): Record<string, HeaderValue>;
  getHeader(name: string): HeaderValue;
  sendHeader(name: string, value: string): void;
  getRequestBody(): Promise<string | ArrayBuffer | undefined>;
  getRequestPath(): string;
}
