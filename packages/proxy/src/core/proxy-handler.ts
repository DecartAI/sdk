import type { DecartProxyOptions } from "./types";

/**
 * Core proxy handler that forwards requests to the Decart API.
 * This is a Web API-compatible handler that can be used with Next.js or converted for Express.
 *
 * @param request - The incoming request to proxy
 * @param options - Proxy configuration options
 * @returns Response from the Decart API
 */
export async function handleProxyRequest(request: Request, options: DecartProxyOptions): Promise<Response> {
  const { apiKey, baseUrl = "https://api.decart.ai", integration } = options;

  // Extract the path from the request URL
  const url = new URL(request.url);
  const path = url.pathname;

  // Build the target URL
  const targetUrl = `${baseUrl}${path}${url.search}`;

  // Prepare headers
  const headers = new Headers();

  // Copy relevant headers from the incoming request
  // Skip X-API-KEY as we'll add our own
  // Preserve User-Agent from client (SDK will set it)
  for (const [key, value] of request.headers.entries()) {
    const lowerKey = key.toLowerCase();
    if (lowerKey !== "x-api-key" && lowerKey !== "host" && lowerKey !== "connection") {
      headers.set(key, value);
    }
  }

  // Add API key header (this is the server's API key)
  headers.set("X-API-KEY", apiKey);

  // If integration is provided and User-Agent doesn't exist, set it
  // Otherwise, preserve the client's User-Agent (which includes SDK info)
  if (integration && !headers.has("User-Agent")) {
    headers.set("User-Agent", `decart-proxy/${integration}`);
  }

  // Prepare the request body
  let body: BodyInit | undefined;
  const contentType = request.headers.get("content-type");

  if (request.method !== "GET" && request.method !== "HEAD") {
    if (contentType?.includes("multipart/form-data")) {
      // For FormData, we need to preserve it as-is
      body = await request.formData();
    } else {
      // For other content types, clone the body
      body = await request.arrayBuffer();
    }
  }

  try {
    // Forward the request to the Decart API
    const response = await fetch(targetUrl, {
      method: request.method,
      headers,
      body,
      signal: request.signal,
    });

    // Create a new response with the same status and headers
    const responseHeaders = new Headers(response.headers);

    // Copy CORS headers if present
    const corsHeaders = [
      "access-control-allow-origin",
      "access-control-allow-methods",
      "access-control-allow-headers",
      "access-control-expose-headers",
    ];

    // Preserve original response headers
    const proxiedResponse = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });

    return proxiedResponse;
  } catch (error) {
    // Handle network errors
    console.error("[Decart Proxy] Error forwarding request:", error);

    return new Response(
      JSON.stringify({
        error: "Proxy error",
        message: error instanceof Error ? error.message : "Unknown error",
      }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  }
}
