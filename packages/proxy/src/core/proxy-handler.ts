import type { HeaderValue, ProxyBehavior } from "./types";

export const DEFAULT_PROXY_ROUTE = "/api/decart";

const DECART_API_KEY = process.env.DECART_API_KEY;

/**
 * Converts a Web API Headers object to a Record<string, HeaderValue>.
 * Handles multiple values for the same header key by combining them into arrays.
 * Header names are normalized to lowercase for case-insensitive matching.
 *
 * @param headers the Headers object to convert.
 * @returns a record mapping header names (lowercase) to their values.
 */
export function fromHeaders(headers: Headers): Record<string, HeaderValue> {
  const result: Record<string, HeaderValue> = {};
  headers.forEach((value, key) => {
    const normalizedKey = key.toLowerCase();
    const existing = result[normalizedKey];
    if (existing) {
      result[normalizedKey] = Array.isArray(existing) ? [...existing, value] : [existing, value];
    } else {
      result[normalizedKey] = value;
    }
  });
  return result;
}

/**
 * Utility to get a header value as `string` from a Headers object.
 *
 * @private
 * @param request the header value.
 * @returns the header value as `string` or `undefined` if the header is not set.
 */
function singleHeaderValue(value: HeaderValue): string | undefined {
  if (!value) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

const EXCLUDED_HEADERS = ["content-length", "content-encoding"];

/**
 * A request handler that proxies the request to the Decart API endpoint.
 *
 * @param behavior the request proxy behavior.
 * @returns Promise<any> the promise that will be resolved once the request is done.
 */
export async function handleRequest<ResponseType>(behavior: ProxyBehavior<ResponseType>) {
  const apiKey = behavior.apiKey ?? DECART_API_KEY;

  if (!apiKey) {
    return behavior.respondWith(401, "Missing Decart API key");
  }

  const baseUrl = behavior.baseUrl ?? "https://api.decart.ai";

  // Use the request path from the middleware
  const requestPath = behavior.getRequestPath();
  const targetUrl = new URL(requestPath, baseUrl);

  const adapterId = behavior.id ?? "custom";
  const proxyUserAgent = behavior.integration
    ? `@decart-ai/server-proxy/${adapterId} (integration: ${behavior.integration})`
    : `@decart-ai/server-proxy/${adapterId}`;

  const userAgent = singleHeaderValue(behavior.getHeader("user-agent"));
  const requestBody = await behavior.getRequestBody();

  const headers: Record<string, string> = {
    "x-api-key": apiKey,
    accept: "application/json",
    "user-agent": userAgent ? `${userAgent} ${proxyUserAgent}` : proxyUserAgent,
  };

  // Preserve the original content-type header (will be multipart/form-data for FormData)
  const contentType = singleHeaderValue(behavior.getHeader("content-type"));
  if (contentType) {
    headers["content-type"] = contentType;
  }

  const res = await fetch(targetUrl.toString(), {
    method: behavior.method,
    headers: headers as HeadersInit,
    body: requestBody || undefined,
  });

  res.headers.forEach((value, key) => {
    if (!EXCLUDED_HEADERS.includes(key.toLowerCase())) {
      behavior.sendHeader(key, value);
    }
  });

  return behavior.sendResponse(res);
}
