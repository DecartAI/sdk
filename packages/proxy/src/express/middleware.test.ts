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

      const response = await request(app).post("/api/decart/v1/generate/lucy-pro-t2i");

      expect(response.status).toBe(401);
      expect(response.body).toEqual("Missing Decart API key");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("should use configured baseUrl", async () => {
      const app = express();
      app.use("/api/decart", handler({ apiKey: "test-key", baseUrl: "https://custom.api.com" }));

      fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));

      await request(app).post("/api/decart/v1/generate/lucy-pro-t2i");

      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("https://custom.api.com/v1/generate/lucy-pro-t2i"),
        expect.anything(),
      );
    });
  });

  describe("Request Proxying", () => {
    it("should forward request method and body", async () => {
      const app = express();

      app.use("/api/decart", handler({ apiKey: "test-key" }));

      fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));

      const testBody = { prompt: "A beautiful sunset over the ocean", resolution: "720p" };
      await request(app).post("/api/decart/v1/generate/lucy-pro-t2i").send(testBody);

      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/v1/generate/lucy-pro-t2i"),
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

      await request(app).get("/api/decart/v1/jobs/job_abc123");

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
        .post("/api/decart/v1/jobs/lucy-pro-t2v")
        .set("User-Agent", "Custom-Agent/1.0")
        .set("Content-Type", "application/json")
        .send({ prompt: "A cat playing piano" });

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

      const mockResponse = JSON.stringify({ job_id: "job_abc123", status: "pending" });
      fetchMock.mockResolvedValue(
        new Response(mockResponse, {
          status: 201,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const response = await request(app).post("/api/decart/v1/jobs/lucy-pro-t2v");

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
            "Content-Encoding": "gzip", // Should be excluded
          },
        }),
      );

      const response = await request(app).get("/api/decart/v1/jobs/job_abc123");

      expect(response.status).toBe(200);
      expect(response.headers["x-custom-header"]).toBe("custom-value");
      expect(response.headers["content-length"]).toBeUndefined();
      expect(response.headers["content-encoding"]).toBeUndefined();
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

      const response = await request(app).post("/api/decart/v1/generate/lucy-pro-t2i");

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: "Internal Server Error" });
    });
  });
});
