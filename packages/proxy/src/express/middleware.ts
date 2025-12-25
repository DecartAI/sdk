import { Readable } from "node:stream";
import type { RequestHandler } from "express";
import { DEFAULT_PROXY_ROUTE, handleRequest } from "../core/proxy-handler";

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
    getRequestBody: async () => JSON.stringify(request.body),
    getHeaders: () => request.headers,
    getHeader: (name) => request.headers[name],
    sendHeader: (name, value) => response.setHeader(name, value),
    respondWith: (status, data) => response.status(status).json(data),
    getRequestPath: () => request.path,
    sendResponse: async (res) => {
      console.log("sending back response", res);
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
