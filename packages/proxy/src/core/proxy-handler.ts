import type { HeaderValue, ProxyBehavior } from "./types";

const DECART_API_KEY = process.env.DECART_API_KEY;

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

  // pass over headers prefixed with x-decart-*
  const proxyUserAgent = behavior.integration
    ? `@decart-ai/server-proxy/${behavior.id} (integration: ${behavior.integration})`
    : `@decart-ai/server-proxy/${behavior.id}`;

  const userAgent = singleHeaderValue(behavior.getHeader("user-agent"));
  const requestBody = await behavior.getRequestBody();

  const headers: Record<string, string> = {
    "x-api-key": apiKey,
    accept: "application/json",
    "x-decart-client-proxy": proxyUserAgent,
  };

  if (userAgent) {
    headers["user-agent"] = userAgent;
  }

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
