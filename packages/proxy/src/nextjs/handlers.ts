import type { NextRequest } from "next/server";
import type { DecartProxyOptions } from "../core/types";
import { handleProxyRequest } from "../core/proxy-handler";

/**
 * Creates Next.js API route handlers for proxying Decart SDK requests.
 *
 * @param options - Proxy configuration options
 * @returns Object with GET and POST handlers for Next.js App Router
 *
 * @example
 * ```ts
 * // app/api/decart/[...path]/route.ts
 * import { createDecartProxyHandler } from '@decartai/proxy/nextjs';
 *
 * export const { GET, POST } = createDecartProxyHandler({
 *   apiKey: process.env.DECART_API_KEY,
 * });
 * ```
 */
export function createDecartProxyHandler(options: DecartProxyOptions) {
  const handler = async (request: NextRequest) => {
    return handleProxyRequest(request, options);
  };

  return {
    GET: handler,
    POST: handler,
  };
}

