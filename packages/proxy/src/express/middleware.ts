import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import type { NextFunction, Request, Response } from "express";
import { version } from "../../package.json";
import { DEFAULT_PROXY_ROUTE, handleRequest } from "../core/proxy-handler";
import type { DecartProxyOptions } from "../core/types";

/**
 * The default Express route for the Decart API client proxy.
 */
export const route = DEFAULT_PROXY_ROUTE;

/**
 * Read the raw request body as FormData (ArrayBuffer)
 */
async function readRequestBody(req: Request): Promise<ArrayBuffer | undefined> {
  const buf = await buffer(req);
  if (buf.length === 0) return undefined;

  // Convert Buffer to ArrayBuffer to preserve binary data for FormData
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

/**
 * The Express route handler for the Decart API client proxy.
 *
 * @param options Optional configuration options, including API key.
 * @returns Express middleware handler function.
 */
export const handler = (options?: DecartProxyOptions) => {
  return async (request: Request, response: Response, next: NextFunction) => {
    try {
      await handleRequest({
        id: `${version}/express`,
        apiKey: options?.apiKey,
        baseUrl: options?.baseUrl,
        integration: options?.integration,
        method: request.method,
        getRequestBody: async () => readRequestBody(request),
        getHeaders: () => request.headers,
        getHeader: (name) => request.headers[name],
        sendHeader: (name, value) => response.setHeader(name, value),
        respondWith: (status, data) => {
          response.status(status).json(data);
        },
        getRequestPath: () => request.path,
        sendResponse: async (res) => {
          response.status(res.status);
          if (res.body) {
            // @ts-expect-error - Readable.fromWeb handles Web ReadableStream
            Readable.fromWeb(res.body).pipe(response);
          } else {
            response.end();
          }
        },
      });
    } catch (error) {
      next(error);
    }
  };
};
