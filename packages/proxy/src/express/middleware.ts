import type { Request, Response, NextFunction } from "express";
import type { DecartProxyOptions } from "../core/types";
import { handleProxyRequest } from "../core/proxy-handler";
import { Readable } from "node:stream";

/**
 * Express middleware for proxying Decart SDK requests.
 *
 * **Important**: For proper FormData handling, you should use `express.raw()` middleware
 * before this proxy to preserve the raw request body. Otherwise, Express may parse
 * multipart/form-data and reconstruction may not be perfect.
 *
 * @param options - Proxy configuration options
 * @returns Express middleware function
 *
 * @example
 * ```ts
 * import express from 'express';
 * import { decartProxy } from '@decartai/proxy/express';
 *
 * const app = express();
 * 
 * // Option 1: Use raw body parser for FormData support
 * app.use('/api/decart', express.raw({ type: 'multipart/form-data', limit: '50mb' }));
 * app.use('/api/decart', decartProxy({
 *   apiKey: process.env.DECART_API_KEY,
 * }));
 * 
 * // Option 2: Standard usage (may have limitations with FormData)
 * app.use('/api/decart', decartProxy({
 *   apiKey: process.env.DECART_API_KEY,
 * }));
 * ```
 */
export function decartProxy(options: DecartProxyOptions) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Build the target URL
      const protocol = req.protocol || "http";
      const host = req.get("host") || "localhost";
      const baseUrl = `${protocol}://${host}`;
      const url = new URL(req.originalUrl || req.url, baseUrl);

      // Create headers
      const headers = new Headers();

      // Copy headers from Express request, excluding ones we'll override
      for (const [key, value] of Object.entries(req.headers)) {
        const lowerKey = key.toLowerCase();
        if (
          lowerKey !== "x-api-key" &&
          lowerKey !== "host" &&
          lowerKey !== "connection" &&
          value
        ) {
          if (Array.isArray(value)) {
            value.forEach((v) => headers.append(key, v));
          } else {
            headers.set(key, value);
          }
        }
      }

      // Get the request body
      let body: BodyInit | undefined;
      if (req.method !== "GET" && req.method !== "HEAD") {
        const contentType = req.get("content-type") || "";

        // If we have a raw buffer (from express.raw()), use it directly
        if (Buffer.isBuffer(req.body)) {
          body = req.body;
        } else if (contentType.includes("multipart/form-data")) {
          // For FormData, try to reconstruct if Express parsed it
          if (req.body && typeof req.body === "object") {
            const formData = new FormData();
            for (const [key, value] of Object.entries(req.body)) {
              if (value instanceof Buffer || value instanceof Uint8Array) {
                formData.append(key, new Blob([value]));
              } else if (typeof value === "string") {
                formData.append(key, value);
              } else {
                formData.append(key, JSON.stringify(value));
              }
            }
            // Handle files from multer or similar
            if (req.files) {
              const files = Array.isArray(req.files) ? req.files : Object.values(req.files).flat();
              for (const file of files) {
                if (file && "fieldname" in file && "buffer" in file) {
                  const blob = new Blob([file.buffer], { type: file.mimetype });
                  formData.append(file.fieldname, blob, file.originalname);
                }
              }
            }
            body = formData;
          }
        } else if (contentType.includes("application/json")) {
          // JSON body
          body = req.body ? JSON.stringify(req.body) : undefined;
        } else if (typeof req.body === "string") {
          body = req.body;
        }
      }

      // Create Web API Request
      const webRequest = new Request(url.toString(), {
        method: req.method,
        headers,
        body,
      });

      // Handle the proxy request
      const response = await handleProxyRequest(webRequest, options);

      // Convert Web API Response back to Express response
      res.status(response.status);

      // Copy headers from response
      response.headers.forEach((value, key) => {
        // Skip headers that Express manages
        const lowerKey = key.toLowerCase();
        if (
          lowerKey !== "connection" &&
          lowerKey !== "transfer-encoding" &&
          lowerKey !== "content-encoding"
        ) {
          res.setHeader(key, value);
        }
      });

      // Stream the response body
      if (response.body) {
        const reader = response.body.getReader();
        const stream = new ReadableStream({
          async start(controller) {
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) {
                  controller.close();
                  break;
                }
                controller.enqueue(value);
              }
            } catch (error) {
              controller.error(error);
            }
          },
        });

        // Convert ReadableStream to Node.js stream
        const nodeStream = Readable.fromWeb(stream);
        nodeStream.pipe(res);
      } else {
        res.end();
      }
    } catch (error) {
      next(error);
    }
  };
}

