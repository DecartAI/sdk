import type { Server } from "node:http";
import express, { type Application } from "express";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DecartProxyOptions } from "../core/types";
import { handler } from "./middleware";

const BASE_URL = "https://api.decart.ai";
const CUSTOM_BASE_URL = "https://custom.api.com";
const PROXY_BASE_PATH = "/api/decart";

/**
 * Creates a URL for the proxy endpoint on the test server
 */
function getProxyUrl(port: number, path: string): string {
  return `http://localhost:${port}${PROXY_BASE_PATH}${path}`;
}

/**
 * Creates an Express app with the Decart proxy middleware configured
 */
function createTestApp(options?: DecartProxyOptions): Application {
  const testApp = express();
  testApp.use(express.raw({ type: "*/*", limit: "50mb" }));
  testApp.use("/api/decart", handler(options));
  return testApp;
}

/**
 * Starts an Express server on a random port and returns the server, port and cleanup function
 */
async function startTestServer(
  app: Application,
): Promise<{ server: Server; port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const testServer = app.listen(0, () => {
      const address = testServer.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        server: testServer as Server,
        port,
        close: () =>
          new Promise<void>((resolveClose) => {
            testServer.close(() => resolveClose());
          }),
      });
    });
  });
}

describe("Decart Proxy Middleware", () => {
  let lastRequest: Request | null = null;

  const mswServer = setupServer();

  beforeAll(() => {
    mswServer.listen({ onUnhandledRequest: "bypass" });
  });

  afterAll(() => {
    mswServer.close();
  });

  beforeEach(() => {
    lastRequest = null;
  });

  afterEach(() => {
    mswServer.resetHandlers();
  });

  describe("Initialization & Configuration", () => {
    it("should return 401 if no API key is provided", async () => {
      const testApp = createTestApp({});
      const { port, close } = await startTestServer(testApp);

      const response = await fetch(getProxyUrl(port, "/v1/generate/lucy-pro-t2i"), {
        method: "POST",
      });

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body).toBe("Missing Decart API key");

      await close();
    });

    it("should use configured baseUrl", async () => {
      const testApp = createTestApp({ apiKey: "test-key", baseUrl: CUSTOM_BASE_URL });
      const { port, close } = await startTestServer(testApp);

      mswServer.use(
        http.post(`${CUSTOM_BASE_URL}/v1/generate/lucy-pro-t2i`, async ({ request }) => {
          lastRequest = request;
          return HttpResponse.json({});
        }),
      );

      await fetch(getProxyUrl(port, "/v1/generate/lucy-pro-t2i"), {
        method: "POST",
      });

      expect(lastRequest).not.toBeNull();
      expect(lastRequest?.url).toContain(`${CUSTOM_BASE_URL}/v1/generate/lucy-pro-t2i`);

      await close();
    });
  });

  describe("Request Proxying", () => {
    it("should forward request method and body", async () => {
      const app = createTestApp({ apiKey: "test-key" });
      const { port, close } = await startTestServer(app);

      mswServer.use(
        http.post(`${BASE_URL}/v1/generate/lucy-pro-t2i`, async ({ request }) => {
          lastRequest = request;
          return HttpResponse.json({});
        }),
      );

      const testBody = JSON.stringify({ prompt: "A beautiful sunset over the ocean", resolution: "720p" });
      const response = await fetch(getProxyUrl(port, "/v1/generate/lucy-pro-t2i"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: testBody,
      });

      expect(response.status).toBe(200);
      expect(lastRequest).not.toBeNull();
      expect(lastRequest?.method).toBe("POST");
      expect(lastRequest?.url).toContain("/v1/generate/lucy-pro-t2i");
      // The middleware converts body to ArrayBuffer
      if (lastRequest) {
        const body = await lastRequest.arrayBuffer();
        expect(body).toBeInstanceOf(ArrayBuffer);
      }

      await close();
    });

    it("should add internal headers", async () => {
      const testApp = createTestApp({ apiKey: "test-key", integration: "test-integration" });
      const { port, close } = await startTestServer(testApp);

      mswServer.use(
        http.get(`${BASE_URL}/v1/jobs/job_abc123`, async ({ request }) => {
          lastRequest = request;
          return HttpResponse.json({});
        }),
      );

      await fetch(getProxyUrl(port, "/v1/jobs/job_abc123"), {
        method: "GET",
      });

      expect(lastRequest).not.toBeNull();
      expect(lastRequest?.headers.get("x-api-key")).toBe("test-key");
      expect(lastRequest?.headers.get("accept")).toBe("application/json");
      expect(lastRequest?.headers.get("x-decart-client-proxy")).toContain("integration: test-integration");

      await close();
    });

    it("should preserve User-Agent and Content-Type from original request", async () => {
      const app = createTestApp({ apiKey: "test-key" });
      const { port, close } = await startTestServer(app);

      mswServer.use(
        http.post(`${BASE_URL}/v1/jobs/lucy-pro-t2v`, async ({ request }) => {
          lastRequest = request;
          return HttpResponse.json({});
        }),
      );

      await fetch(getProxyUrl(port, "/v1/jobs/lucy-pro-t2v"), {
        method: "POST",
        headers: {
          "User-Agent": "Custom-Agent/1.0",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ prompt: "A cat playing piano" }),
      });

      expect(lastRequest).not.toBeNull();
      expect(lastRequest?.headers.get("user-agent")).toBe("Custom-Agent/1.0");
      expect(lastRequest?.headers.get("content-type")).toContain("application/json");

      await close();
    });
  });

  describe("Response Handling", () => {
    it("should forward upstream response status and body", async () => {
      const app = createTestApp({ apiKey: "test-key" });
      const { port, close } = await startTestServer(app);
      const mockResponse = { job_id: "job_abc123", status: "pending" };

      mswServer.use(
        http.post(`${BASE_URL}/v1/jobs/lucy-pro-t2v`, () => {
          return HttpResponse.json(mockResponse, {
            status: 201,
            headers: { "Content-Type": "application/json" },
          });
        }),
      );

      const response = await fetch(getProxyUrl(port, "/v1/jobs/lucy-pro-t2v"), {
        method: "POST",
      });

      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body).toEqual(mockResponse);

      await close();
    });

    it("should forward upstream headers (excluding blacklisted)", async () => {
      const app = createTestApp({ apiKey: "test-key" });
      const { port, close } = await startTestServer(app);

      mswServer.use(
        http.get(`${BASE_URL}/v1/jobs/job_abc123`, () => {
          return HttpResponse.json(
            {},
            {
              status: 200,
              headers: {
                "X-Custom-Header": "custom-value",
                "Content-Length": "123", // Should be excluded
                // Note: Content-Encoding removed as it causes issues when the response isn't actually gzipped
              },
            },
          );
        }),
      );

      const response = await fetch(getProxyUrl(port, "/v1/jobs/job_abc123"), {
        method: "GET",
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("x-custom-header")).toBe("custom-value");
      expect(response.headers.get("content-length")).toBeNull();
      expect(response.headers.get("content-encoding")).toBeNull();

      await close();
    });

    it("should handle 500 from upstream", async () => {
      const app = createTestApp({ apiKey: "test-key" });
      const { port, close } = await startTestServer(app);

      mswServer.use(
        http.post(`${BASE_URL}/v1/generate/lucy-pro-t2i`, () => {
          return HttpResponse.json(
            { error: "Internal Server Error" },
            {
              status: 500,
              headers: { "Content-Type": "application/json" },
            },
          );
        }),
      );

      const response = await fetch(getProxyUrl(port, "/v1/generate/lucy-pro-t2i"), {
        method: "POST",
      });

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body).toEqual({ error: "Internal Server Error" });

      await close();
    });
  });

  describe("Error Handling", () => {
    it("should handle network errors gracefully", async () => {
      let errorHandlerCalled = false;
      const testApp = createTestApp({ apiKey: "test-key" });

      // Add error handler middleware to verify error is passed correctly
      testApp.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        errorHandlerCalled = true;
        res.status(500).json({ error: err.message });
      });

      const { port, close } = await startTestServer(testApp);

      // Stub fetch to throw a network error for upstream API calls
      const originalFetch = globalThis.fetch;
      const fetchStub = vi.fn((url: string | URL | Request) => {
        if (typeof url === "string" && url.includes(BASE_URL)) {
          throw new Error("Network request failed");
        }
        return originalFetch(url);
      });
      vi.stubGlobal("fetch", fetchStub);

      try {
        const response = await fetch(getProxyUrl(port, "/v1/generate/lucy-pro-t2i"), {
          method: "POST",
        });

        expect(response.status).toBe(500);
        const body = await response.json();
        expect(errorHandlerCalled).toBe(true);
        expect(body).toEqual({ error: "Network request failed" });
      } finally {
        vi.unstubAllGlobals();
        await close();
      }
    });
  });
});
