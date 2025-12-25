import { Readable } from "node:stream";
import type { Request, RequestHandler } from "express";
import { DEFAULT_PROXY_ROUTE, handleRequest } from "../core/proxy-handler";

/**
 * Read the raw request body as FormData (ArrayBuffer)
 */
async function readRequestBody(req: Request): Promise<ArrayBuffer | undefined> {
  // GET, HEAD, and OPTIONS requests don't have bodies
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
    return undefined;
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    // Check if stream is already consumed
    if (req.readableEnded) {
      resolve(undefined);
      return;
    }

    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve(undefined);
      } else {
        const body = Buffer.concat(chunks);
        // Convert Buffer to ArrayBuffer to preserve binary data for FormData
        resolve(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength));
      }
    });
    req.on("error", reject);
  });
}

/**
 * The default Express route for the Decart API client proxy.
 */
export const route = DEFAULT_PROXY_ROUTE;

/**
 * The Express route handler for the Decart API client proxy.
 *
 * @param request The Express request object.
 * @param response The Express response object.
 * @param next The Express next function.
 */
export const handler: RequestHandler = async (request, response, next) => {
  await handleRequest({
    id: "express",
    method: request.method,
    getRequestBody: async () => readRequestBody(request),
    getHeaders: () => request.headers,
    getHeader: (name) => request.headers[name],
    sendHeader: (name, value) => response.setHeader(name, value),
    respondWith: (status, data) => response.status(status).json(data),
    getRequestPath: () => request.path,
    sendResponse: async (res) => {
      response.status(res.status);
      if (res.body) {
        // @ts-expect-error - Readable.fromWeb handles Web ReadableStream
        Readable.fromWeb(res.body).pipe(response);
      } else {
        response.end();
      }

      return response;
    },
  });
  next();
};
