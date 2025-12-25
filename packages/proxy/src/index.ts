/**
 * @decartai/proxy - Server-side proxy middleware for Decart SDK
 *
 * This package provides ready-to-use proxy middleware for Express and Next.js
 * servers, allowing you to use the Decart SDK on the client side while keeping
 * your API key secure on the server.
 *
 * @example
 * ```ts
 * // Express
 * import { decartProxy } from '@decartai/proxy/express';
 * app.use('/api/decart', decartProxy({ apiKey: process.env.DECART_API_KEY }));
 *
 * // Next.js
 * import { createDecartProxyHandler } from '@decartai/proxy/nextjs';
 * export const { GET, POST } = createDecartProxyHandler({ apiKey: process.env.DECART_API_KEY });
 * ```
 */

export { handleRequest } from "./core/proxy-handler";
export type { DecartProxyOptions } from "./core/types";
export { handler as decartProxy } from "./express/middleware";
