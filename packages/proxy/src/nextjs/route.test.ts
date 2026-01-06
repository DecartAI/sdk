import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handler, PROXY_ROUTE, route } from "./route";

const BASE_URL = "https://api.decart.ai";
const CUSTOM_BASE_URL = "https://custom.api.com";

/**
 * Creates a NextRequest for testing the App Router handler
 */
function createNextRequest(
  path: string,
  options?: {
    method?: string;
    body?: string;
    headers?: Record<string, string>;
  },
): NextRequest {
  const url = `http://localhost:3000${PROXY_ROUTE}${path}`;
  return new NextRequest(url, {
    method: options?.method ?? "GET",
    body: options?.body,
    headers: options?.headers,
  });
}

/**
 * Creates mock NextApiRequest and NextApiResponse for testing the Pages Router handler
 */
function createMockPagesRouter(
  path: string[],
  options?: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string | string[] | undefined>;
  },
) {
  const responseHeaders: Record<string, string | number | string[]> = {};
  let responseStatus = 200;
  let responseBody: unknown = null;

  const req = {
    method: options?.method ?? "GET",
    body: options?.body,
    headers: options?.headers ?? {},
    query: { path },
  };

  const res = {
    setHeader: vi.fn((name: string, value: string | number | string[]) => {
      responseHeaders[name] = value;
      return res;
    }),
    status: vi.fn((status: number) => {
      responseStatus = status;
      return res;
    }),
    json: vi.fn((data: unknown) => {
      responseBody = data;
      return res;
    }),
    send: vi.fn((data: unknown) => {
      responseBody = data;
      return res;
    }),
  };

  return {
    req,
    res,
    getResponse: () => ({
      status: responseStatus,
      body: responseBody,
      headers: responseHeaders,
    }),
  };
}

describe("Next.js Proxy Adapter", () => {
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

  describe("App Router", () => {
    describe("Initialization & Configuration", () => {
      it("should return 401 if no API key is provided", async () => {
        const handlers = route({});
        const request = createNextRequest("/v1/generate/lucy-pro-t2i", { method: "POST" });

        const response = await handlers.POST(request);

        expect(response.status).toBe(401);
        const body = await response.json();
        expect(body).toBe("Missing Decart API key");
      });

      it("should fall back to DECART_API_KEY env var when apiKey not provided", async () => {
        const originalApiKey = process.env.DECART_API_KEY;
        process.env.DECART_API_KEY = "env-api-key";

        try {
          // Reset modules so proxy-handler.ts re-reads DECART_API_KEY at import time
          vi.resetModules();
          const { route: envRoute } = await import("./route");

          mswServer.use(
            http.get(`${BASE_URL}/v1/jobs/job_env_fallback`, async ({ request }) => {
              lastRequest = request;
              return HttpResponse.json({});
            }),
          );

          const request = createNextRequest("/v1/jobs/job_env_fallback", { method: "GET" });
          await envRoute({}).GET(request);

          expect(lastRequest).not.toBeNull();
          expect(lastRequest?.headers.get("x-api-key")).toBe("env-api-key");
        } finally {
          if (originalApiKey === undefined) {
            delete process.env.DECART_API_KEY;
          } else {
            process.env.DECART_API_KEY = originalApiKey;
          }
        }
      });

      it("should prefer explicit apiKey over DECART_API_KEY env var", async () => {
        const originalApiKey = process.env.DECART_API_KEY;
        process.env.DECART_API_KEY = "env-api-key";

        try {
          // Reset modules so proxy-handler.ts re-reads DECART_API_KEY at import time
          vi.resetModules();
          const { route: envRoute } = await import("./route");

          mswServer.use(
            http.get(`${BASE_URL}/v1/jobs/job_explicit_key`, async ({ request }) => {
              lastRequest = request;
              return HttpResponse.json({});
            }),
          );

          const request = createNextRequest("/v1/jobs/job_explicit_key", { method: "GET" });
          await envRoute({ apiKey: "explicit-api-key" }).GET(request);

          expect(lastRequest).not.toBeNull();
          expect(lastRequest?.headers.get("x-api-key")).toBe("explicit-api-key");
        } finally {
          if (originalApiKey === undefined) {
            delete process.env.DECART_API_KEY;
          } else {
            process.env.DECART_API_KEY = originalApiKey;
          }
        }
      });

      it("should use configured baseUrl", async () => {
        const handlers = route({ apiKey: "test-key", baseUrl: CUSTOM_BASE_URL });

        mswServer.use(
          http.post(`${CUSTOM_BASE_URL}/v1/generate/lucy-pro-t2i`, async ({ request }) => {
            lastRequest = request;
            return HttpResponse.json({});
          }),
        );

        const request = createNextRequest("/v1/generate/lucy-pro-t2i", { method: "POST" });
        await handlers.POST(request);

        expect(lastRequest).not.toBeNull();
        expect(lastRequest?.url).toContain(`${CUSTOM_BASE_URL}/v1/generate/lucy-pro-t2i`);
      });
    });

    describe("Request Proxying", () => {
      it("should forward request method and body", async () => {
        const handlers = route({ apiKey: "test-key" });

        mswServer.use(
          http.post(`${BASE_URL}/v1/generate/lucy-pro-t2i`, async ({ request }) => {
            lastRequest = request;
            return HttpResponse.json({});
          }),
        );

        const testBody = JSON.stringify({ prompt: "A beautiful sunset over the ocean", resolution: "720p" });
        const request = createNextRequest("/v1/generate/lucy-pro-t2i", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: testBody,
        });

        const response = await handlers.POST(request);

        expect(response.status).toBe(200);
        expect(lastRequest).not.toBeNull();
        expect(lastRequest?.method).toBe("POST");
        expect(lastRequest?.url).toContain("/v1/generate/lucy-pro-t2i");

        if (lastRequest) {
          const body = await lastRequest.text();
          expect(body).toBe(testBody);
        }
      });

      it("should add internal headers", async () => {
        const handlers = route({ apiKey: "test-key", integration: "test-integration" });

        mswServer.use(
          http.get(`${BASE_URL}/v1/jobs/job_abc123`, async ({ request }) => {
            lastRequest = request;
            return HttpResponse.json({});
          }),
        );

        const request = createNextRequest("/v1/jobs/job_abc123", { method: "GET" });
        await handlers.GET(request);

        expect(lastRequest).not.toBeNull();
        expect(lastRequest?.headers.get("x-api-key")).toBe("test-key");
        expect(lastRequest?.headers.get("accept")).toBe("application/json");
        expect(lastRequest?.headers.get("user-agent")).toContain("integration: test-integration");
      });

      it("should preserve User-Agent and Content-Type from original request", async () => {
        const handlers = route({ apiKey: "test-key" });

        mswServer.use(
          http.post(`${BASE_URL}/v1/jobs/lucy-pro-t2v`, async ({ request }) => {
            lastRequest = request;
            return HttpResponse.json({});
          }),
        );

        const request = createNextRequest("/v1/jobs/lucy-pro-t2v", {
          method: "POST",
          headers: {
            "User-Agent": "Custom-Agent/1.0",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ prompt: "A cat playing piano" }),
        });

        await handlers.POST(request);

        expect(lastRequest).not.toBeNull();
        expect(lastRequest?.headers.get("user-agent")).toContain("Custom-Agent/1.0");
        expect(lastRequest?.headers.get("content-type")).toContain("application/json");
      });
    });

    describe("Response Handling", () => {
      it("should forward upstream response status and body", async () => {
        const handlers = route({ apiKey: "test-key" });
        const mockResponse = { job_id: "job_abc123", status: "pending" };

        mswServer.use(
          http.post(`${BASE_URL}/v1/jobs/lucy-pro-t2v`, () => {
            return HttpResponse.json(mockResponse, {
              status: 201,
              headers: { "Content-Type": "application/json" },
            });
          }),
        );

        const request = createNextRequest("/v1/jobs/lucy-pro-t2v", { method: "POST" });
        const response = await handlers.POST(request);

        expect(response.status).toBe(201);
        const body = await response.json();
        expect(body).toEqual(mockResponse);
      });

      it("should forward upstream headers (excluding blacklisted)", async () => {
        const handlers = route({ apiKey: "test-key" });

        mswServer.use(
          http.get(`${BASE_URL}/v1/jobs/job_abc123`, () => {
            return HttpResponse.json(
              {},
              {
                status: 200,
                headers: {
                  "X-Custom-Header": "custom-value",
                  "Content-Length": "123", // Should be excluded
                },
              },
            );
          }),
        );

        const request = createNextRequest("/v1/jobs/job_abc123", { method: "GET" });
        const response = await handlers.GET(request);

        expect(response.status).toBe(200);
        expect(response.headers.get("x-custom-header")).toBe("custom-value");
        expect(response.headers.get("content-length")).toBeNull();
        expect(response.headers.get("content-encoding")).toBeNull();
      });

      it("should handle 500 from upstream", async () => {
        const handlers = route({ apiKey: "test-key" });

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

        const request = createNextRequest("/v1/generate/lucy-pro-t2i", { method: "POST" });
        const response = await handlers.POST(request);

        expect(response.status).toBe(500);
        const body = await response.json();
        expect(body).toEqual({ error: "Internal Server Error" });
      });
    });

    describe("Error Handling", () => {
      it("should handle network errors gracefully", async () => {
        const handlers = route({ apiKey: "test-key" });

        mswServer.use(
          http.post(`${BASE_URL}/v1/generate/lucy-pro-t2i`, () => {
            return HttpResponse.error();
          }),
        );

        const request = createNextRequest("/v1/generate/lucy-pro-t2i", { method: "POST" });
        const response = await handlers.POST(request);

        expect(response.status).toBe(500);
        const body = await response.json();
        expect(body).toEqual({ error: "Internal server error" });
      });
    });
  });

  describe("Pages Router", () => {
    describe("Initialization & Configuration", () => {
      it("should return 401 if no API key is provided", async () => {
        const proxyHandler = handler({});
        const { req, res, getResponse } = createMockPagesRouter(["v1", "generate", "lucy-pro-t2i"], {
          method: "POST",
        });

        // @ts-expect-error - mock objects don't fully implement the types
        await proxyHandler(req, res);

        const response = getResponse();
        expect(response.status).toBe(401);
        expect(response.body).toBe("Missing Decart API key");
      });

      it("should use configured baseUrl", async () => {
        const proxyHandler = handler({ apiKey: "test-key", baseUrl: CUSTOM_BASE_URL });

        mswServer.use(
          http.post(`${CUSTOM_BASE_URL}/v1/generate/lucy-pro-t2i`, async ({ request }) => {
            lastRequest = request;
            return HttpResponse.json({});
          }),
        );

        const { req, res } = createMockPagesRouter(["v1", "generate", "lucy-pro-t2i"], {
          method: "POST",
        });

        // @ts-expect-error - mock objects don't fully implement the types
        await proxyHandler(req, res);

        expect(lastRequest).not.toBeNull();
        expect(lastRequest?.url).toContain(`${CUSTOM_BASE_URL}/v1/generate/lucy-pro-t2i`);
      });
    });

    describe("Request Proxying", () => {
      it("should forward request method and body", async () => {
        const proxyHandler = handler({ apiKey: "test-key" });

        mswServer.use(
          http.post(`${BASE_URL}/v1/generate/lucy-pro-t2i`, async ({ request }) => {
            lastRequest = request;
            return HttpResponse.json({});
          }),
        );

        const testBody = { prompt: "A beautiful sunset over the ocean", resolution: "720p" };
        const { req, res, getResponse } = createMockPagesRouter(["v1", "generate", "lucy-pro-t2i"], {
          method: "POST",
          body: testBody,
          headers: { "content-type": "application/json" },
        });

        // @ts-expect-error - mock objects don't fully implement the types
        await proxyHandler(req, res);

        const response = getResponse();
        expect(response.status).toBe(200);
        expect(lastRequest).not.toBeNull();
        expect(lastRequest?.method).toBe("POST");
        expect(lastRequest?.url).toContain("/v1/generate/lucy-pro-t2i");

        if (lastRequest) {
          const body = await lastRequest.text();
          expect(body).toBe(JSON.stringify(testBody));
        }
      });

      it("should add internal headers", async () => {
        const proxyHandler = handler({ apiKey: "test-key", integration: "test-integration" });

        mswServer.use(
          http.get(`${BASE_URL}/v1/jobs/job_abc123`, async ({ request }) => {
            lastRequest = request;
            return HttpResponse.json({});
          }),
        );

        const { req, res } = createMockPagesRouter(["v1", "jobs", "job_abc123"], {
          method: "GET",
        });

        // @ts-expect-error - mock objects don't fully implement the types
        await proxyHandler(req, res);

        expect(lastRequest).not.toBeNull();
        expect(lastRequest?.headers.get("x-api-key")).toBe("test-key");
        expect(lastRequest?.headers.get("accept")).toBe("application/json");
        expect(lastRequest?.headers.get("user-agent")).toContain("integration: test-integration");
      });

      it("should preserve User-Agent and Content-Type from original request", async () => {
        const proxyHandler = handler({ apiKey: "test-key" });

        mswServer.use(
          http.post(`${BASE_URL}/v1/jobs/lucy-pro-t2v`, async ({ request }) => {
            lastRequest = request;
            return HttpResponse.json({});
          }),
        );

        const { req, res } = createMockPagesRouter(["v1", "jobs", "lucy-pro-t2v"], {
          method: "POST",
          body: { prompt: "A cat playing piano" },
          headers: {
            "user-agent": "Custom-Agent/1.0",
            "content-type": "application/json",
          },
        });

        // @ts-expect-error - mock objects don't fully implement the types
        await proxyHandler(req, res);

        expect(lastRequest).not.toBeNull();
        expect(lastRequest?.headers.get("user-agent")).toContain("Custom-Agent/1.0");
        expect(lastRequest?.headers.get("content-type")).toContain("application/json");
      });
    });

    describe("Response Handling", () => {
      it("should forward upstream response status and body", async () => {
        const proxyHandler = handler({ apiKey: "test-key" });
        const mockResponse = { job_id: "job_abc123", status: "pending" };

        mswServer.use(
          http.post(`${BASE_URL}/v1/jobs/lucy-pro-t2v`, () => {
            return HttpResponse.json(mockResponse, {
              status: 201,
              headers: { "Content-Type": "application/json" },
            });
          }),
        );

        const { req, res, getResponse } = createMockPagesRouter(["v1", "jobs", "lucy-pro-t2v"], {
          method: "POST",
        });

        // @ts-expect-error - mock objects don't fully implement the types
        await proxyHandler(req, res);

        const response = getResponse();
        expect(response.status).toBe(201);
        expect(response.body).toEqual(mockResponse);
      });

      it("should forward upstream headers (excluding blacklisted)", async () => {
        const proxyHandler = handler({ apiKey: "test-key" });

        mswServer.use(
          http.get(`${BASE_URL}/v1/jobs/job_abc123`, () => {
            return HttpResponse.json(
              {},
              {
                status: 200,
                headers: {
                  "X-Custom-Header": "custom-value",
                  "Content-Length": "123", // Should be excluded
                },
              },
            );
          }),
        );

        const { req, res, getResponse } = createMockPagesRouter(["v1", "jobs", "job_abc123"], {
          method: "GET",
        });

        // @ts-expect-error - mock objects don't fully implement the types
        await proxyHandler(req, res);

        const response = getResponse();
        expect(response.status).toBe(200);
        expect(response.headers["x-custom-header"]).toBe("custom-value");
        expect(response.headers["content-length"]).toBeUndefined();
        expect(response.headers["content-encoding"]).toBeUndefined();
      });

      it("should handle 500 from upstream", async () => {
        const proxyHandler = handler({ apiKey: "test-key" });

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

        const { req, res, getResponse } = createMockPagesRouter(["v1", "generate", "lucy-pro-t2i"], {
          method: "POST",
        });

        // @ts-expect-error - mock objects don't fully implement the types
        await proxyHandler(req, res);

        const response = getResponse();
        expect(response.status).toBe(500);
        expect(response.body).toEqual({ error: "Internal Server Error" });
      });
    });

    describe("Error Handling", () => {
      it("should handle network errors gracefully", async () => {
        const proxyHandler = handler({ apiKey: "test-key" });

        mswServer.use(
          http.post(`${BASE_URL}/v1/generate/lucy-pro-t2i`, () => {
            return HttpResponse.error();
          }),
        );

        const { req, res, getResponse } = createMockPagesRouter(["v1", "generate", "lucy-pro-t2i"], {
          method: "POST",
        });

        // @ts-expect-error - mock objects don't fully implement the types
        await proxyHandler(req, res);

        const response = getResponse();
        expect(response.status).toBe(500);
        expect(response.body).toEqual({ error: "Internal server error" });
      });
    });

    describe("Path Handling", () => {
      it("should handle empty path", async () => {
        const proxyHandler = handler({ apiKey: "test-key" });

        mswServer.use(
          http.get(`${BASE_URL}/`, async ({ request }) => {
            lastRequest = request;
            return HttpResponse.json({ message: "root" });
          }),
        );

        const { req, res } = createMockPagesRouter([], {
          method: "GET",
        });

        // @ts-expect-error - mock objects don't fully implement the types
        await proxyHandler(req, res);

        expect(lastRequest).not.toBeNull();
        if (!lastRequest?.url) {
          throw new Error("Expected request url to be defined");
        }
        expect(new URL(lastRequest.url).pathname).toBe("/");
      });
    });
  });
});
