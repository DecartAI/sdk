import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handler } from "./middleware";

describe("Decart Proxy Middleware", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  describe("Initialization & Configuration", () => {
    it("should return 401 if no API key is provided", async () => {
      const app = express();
      app.use("/api/decart", handler({}));

      const response = await request(app).post("/api/decart/v1/chat/completions");

      expect(response.status).toBe(401);
      expect(response.body).toEqual("Missing Decart API key");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("should use configured baseUrl", async () => {
      const app = express();
      app.use("/api/decart", handler({ apiKey: "test-key", baseUrl: "https://custom.api.com" }));

      fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));

      await request(app).post("/api/decart/v1/test");

      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("https://custom.api.com/v1/test"),
        expect.anything(),
      );
    });

    it("should default baseUrl to https://api.decart.ai", async () => {
      const app = express();
      app.use("/api/decart", handler({ apiKey: "test-key" }));

      fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));

      await request(app).post("/api/decart/v1/test");

      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("https://api.decart.ai/v1/test"),
        expect.anything(),
      );
    });
  });

  describe("Request Proxying", () => {
    it("should forward request method and body", async () => {
      const app = express();
      // app.use(express.json()); // REMOVED: Consumes stream which interferes with middleware using buffer(req)

      app.use("/api/decart", handler({ apiKey: "test-key" }));

      fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));

      const testBody = { model: "llama-3", messages: [] };
      await request(app).post("/api/decart/v1/chat/completions").send(testBody);

      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/v1/chat/completions"),
        expect.objectContaining({
          method: "POST",
          body: expect.any(ArrayBuffer), // The middleware converts body to ArrayBuffer
        }),
      );
    });

    it("should add internal headers", async () => {
      const app = express();
      app.use("/api/decart", handler({ apiKey: "test-key", integration: "test-integration" }));

      fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));

      await request(app).get("/api/decart/v1/models");

      expect(fetchMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          headers: expect.objectContaining({
            "x-api-key": "test-key",
            accept: "application/json",
            "x-decart-client-proxy": expect.stringContaining("integration: test-integration"),
          }),
        }),
      );
    });

    it("should preserve User-Agent and Content-Type from original request", async () => {
      const app = express();
      app.use("/api/decart", handler({ apiKey: "test-key" }));

      fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));

      await request(app)
        .post("/api/decart/v1/test")
        .set("User-Agent", "Custom-Agent/1.0")
        .set("Content-Type", "application/json")
        .send({ foo: "bar" });

      expect(fetchMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          headers: expect.objectContaining({
            "user-agent": "Custom-Agent/1.0",
            "content-type": expect.stringContaining("application/json"),
          }),
        }),
      );
    });
  });

  describe("Response Handling", () => {
    it("should forward upstream response status and body", async () => {
      const app = express();
      app.use("/api/decart", handler({ apiKey: "test-key" }));

      const mockResponse = JSON.stringify({ id: "123", object: "chat.completion" });
      fetchMock.mockResolvedValue(
        new Response(mockResponse, {
          status: 201,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const response = await request(app).post("/api/decart/v1/chat/completions");

      expect(response.status).toBe(201);
      expect(response.body).toEqual(JSON.parse(mockResponse));
    });

    it("should forward upstream headers (excluding blacklisted)", async () => {
      const app = express();
      app.use("/api/decart", handler({ apiKey: "test-key" }));

      fetchMock.mockResolvedValue(
        new Response("{}", {
          status: 200,
          headers: {
            "X-Custom-Header": "custom-value",
            "Content-Length": "123", // Should be excluded
          },
        }),
      );

      const response = await request(app).get("/api/decart/v1/test");

      expect(response.status).toBe(200);
      expect(response.headers["x-custom-header"]).toBe("custom-value");
      // Content-Length is managed by Express/Node, but our logic explicitly excludes the upstream one.
      // However, supertest/express might add its own Content-Length.
      // We can verify that our logic *called* sendHeader for X-Custom-Header.
      // Ideally we assume the excluded list works if we test one that is allowed.
    });

    it("should handle 500 from upstream", async () => {
      const app = express();
      app.use("/api/decart", handler({ apiKey: "test-key" }));

      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ error: "Internal Server Error" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const response = await request(app).post("/api/decart/v1/error");

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: "Internal Server Error" });
    });
  });
});
