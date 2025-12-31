import type { NextApiRequest, NextApiResponse } from "next";
import { type NextRequest, NextResponse } from "next/server";
import type { NextApiHandler } from "next/types";
import { version } from "../../package.json";
import { DEFAULT_PROXY_ROUTE, handleRequest } from "../core/proxy-handler";
import type { DecartProxyOptions } from "../core/types";

/**
 * The default Next API route for the Decart API client proxy.
 */
export const PROXY_ROUTE = DEFAULT_PROXY_ROUTE;

/**
 * Convert Headers to a record for compatibility
 */
function fromHeaders(headers: Headers): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

/**
 * Response passthrough helper for App Router
 */
const responsePassthrough = async (res: Response, responseHeaders: Headers): Promise<NextResponse> => {
  // Copy response headers
  res.headers.forEach((value, key) => {
    responseHeaders.set(key, value);
  });
  return new NextResponse(res.body, {
    status: res.status,
    headers: responseHeaders,
  });
};

/**
 * The Next API route handler for the Decart API client proxy.
 * Use it with the /pages router in Next.js.
 *
 * Note: the page routers proxy doesn't support streaming responses.
 *
 * @param options Optional configuration options, including API key.
 * @returns Next.js API route handler function.
 */
export const handler = (options?: DecartProxyOptions): NextApiHandler => {
  return async (request: NextApiRequest, response: NextApiResponse) => {
    try {
      return await handleRequest({
        id: `${version}/nextjs-page-router`,
        apiKey: options?.apiKey,
        baseUrl: options?.baseUrl,
        integration: options?.integration,
        method: request.method || "POST",
        getRequestBody: async () => JSON.stringify(request.body),
        getHeaders: () => request.headers,
        getHeader: (name) => request.headers[name],
        sendHeader: (name, value) => response.setHeader(name, value),
        respondWith: (status, data) => response.status(status).json(data),
        getRequestPath: () => {
          // Extract path from catch-all route query param
          if (request.query?.path) {
            const path = Array.isArray(request.query.path) ? request.query.path.join("/") : request.query.path;
            return `/${path}`;
          }
          // Fallback: extract from URL
          const url = request.url?.split("?")[0] || "/";
          const routePath = PROXY_ROUTE.replace(/\/$/, "");
          return url.startsWith(routePath) ? url.slice(routePath.length) || "/" : url;
        },
        sendResponse: async (res) => {
          if (res.headers.get("content-type")?.includes("application/json")) {
            return response.status(res.status).json(await res.json());
          }
          return response.status(res.status).send(await res.text());
        },
      });
    } catch {
      response.status(500).json({ error: "Internal server error" });
    }
  };
};

/**
 * The Next API route handler for the Decart API client proxy on App Router apps.
 *
 * @param request the Next API request object.
 * @param options Optional configuration options, including API key.
 * @returns a promise that resolves when the request is handled.
 */
async function routeHandler(request: NextRequest, options?: DecartProxyOptions): Promise<NextResponse> {
  const responseHeaders = new Headers();
  return await handleRequest({
    id: `${version}/nextjs-app-router`,
    apiKey: options?.apiKey,
    baseUrl: options?.baseUrl,
    integration: options?.integration,
    method: request.method,
    getRequestBody: async () => request.text(),
    getHeaders: () => fromHeaders(request.headers),
    getHeader: (name) => request.headers.get(name),
    sendHeader: (name, value) => responseHeaders.set(name, value),
    respondWith: (status, data) =>
      NextResponse.json(data, {
        status,
        headers: responseHeaders,
      }),
    getRequestPath: () => {
      const url = new URL(request.url);
      const routePath = PROXY_ROUTE.replace(/\/$/, "");
      const pathname = url.pathname;
      return pathname.startsWith(routePath) ? pathname.slice(routePath.length) || "/" : pathname;
    },
    sendResponse: async (res) => responsePassthrough(res, responseHeaders),
  });
}

/**
 * Create route handlers with optional configuration
 */
export const route = (options?: DecartProxyOptions) => ({
  handler: (request: NextRequest) => routeHandler(request, options),
  GET: (request: NextRequest) => routeHandler(request, options),
  POST: (request: NextRequest) => routeHandler(request, options),
  PUT: (request: NextRequest) => routeHandler(request, options),
});

/**
 * Default export for Next.js Pages Router compatibility.
 * Usage in pages/api/decart/[...path].ts:
 * ```typescript
 * import decartProxy from "@decartai/proxy/nextjs";
 * export default decartProxy();
 * ```
 */
export default handler;

// Legacy exports for backwards compatibility
export const handlerPagesRouter = handler;
export const handlerAppRouter = (options?: DecartProxyOptions) => {
  return (req: NextRequest) => routeHandler(req, options);
};
