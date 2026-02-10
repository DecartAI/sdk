import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDecartClient, models } from "../src/index.js";

const MOCK_RESPONSE_DATA = new Uint8Array([0x00, 0x01, 0x02]).buffer;
const TEST_API_KEY = "test-api-key";
const BASE_URL = "http://localhost";

describe("Decart SDK", () => {
  describe("createDecartClient", () => {
    afterEach(() => {
      delete process.env.DECART_API_KEY;
    });

    it("creates a client with explicit apiKey", () => {
      const decart = createDecartClient({
        apiKey: "test",
      });

      expect(decart).toBeDefined();
    });

    it("creates a client using DECART_API_KEY env var", () => {
      process.env.DECART_API_KEY = "env-api-key";
      const decart = createDecartClient();
      expect(decart).toBeDefined();
    });

    it("throws an error if api key is not provided and env var is not set", () => {
      expect(() => createDecartClient()).toThrow("Missing API key");
    });

    it("throw an error if api key is empty string", () => {
      expect(() => createDecartClient({ apiKey: "" })).toThrow("Missing API key");
    });

    it("does not throw an error if proxy is provided", () => {
      expect(() => createDecartClient({ proxy: "/pai/decart" })).not.toThrow("Missing API key");
    });

    it("throws an error if env var is empty string", () => {
      process.env.DECART_API_KEY = "";
      expect(() => createDecartClient()).toThrow("Missing API key");
    });

    it("throws an error if env var is only whitespace", () => {
      process.env.DECART_API_KEY = "   ";
      expect(() => createDecartClient()).toThrow("Missing API key");
    });

    it("throws an error if invalid base url is provided", () => {
      expect(() => createDecartClient({ apiKey: "test", baseUrl: "not-a-url" })).toThrow("Invalid base URL");
    });
  });

  describe("Process API", () => {
    let decart: ReturnType<typeof createDecartClient>;
    let lastFormData: FormData | null = null;
    let lastRequest: Request | null = null;

    const createMockHandler = (endpoint: string) => {
      return http.post(`${BASE_URL}${endpoint}`, async ({ request }) => {
        lastRequest = request;
        lastFormData = await request.formData();
        return HttpResponse.arrayBuffer(MOCK_RESPONSE_DATA, {
          headers: { "Content-Type": "application/octet-stream" },
        });
      });
    };

    const server = setupServer();

    beforeAll(() => {
      server.listen({ onUnhandledRequest: "error" });
    });

    afterAll(() => {
      server.close();
    });

    beforeEach(() => {
      lastFormData = null;
      lastRequest = null;
      decart = createDecartClient({
        apiKey: TEST_API_KEY,
        baseUrl: BASE_URL,
      });
    });

    afterEach(() => {
      server.resetHandlers();
    });

    describe("Model Processing", () => {
      it("processes text-to-image", async () => {
        server.use(createMockHandler("/v1/generate/lucy-pro-t2i"));

        const result = await decart.process({
          model: models.image("lucy-pro-t2i"),
          prompt: "A cat playing piano",
          seed: 42,
        });

        expect(result).toBeInstanceOf(Blob);
        expect(lastRequest?.headers.get("x-api-key")).toBe(TEST_API_KEY);
        expect(lastFormData?.get("prompt")).toBe("A cat playing piano");
        expect(lastFormData?.get("seed")).toBe("42");
      });

      it("includes User-Agent header in requests", async () => {
        server.use(createMockHandler("/v1/generate/lucy-pro-t2i"));

        await decart.process({
          model: models.image("lucy-pro-t2i"),
          prompt: "Test prompt",
        });

        const userAgent = lastRequest?.headers.get("user-agent");
        expect(userAgent).toBeDefined();
        expect(userAgent).toMatch(/^decart-js-sdk\/[\d.]+-?\w* lang\/js runtime\/[\w./]+$/);
      });

      it("includes integration parameter in User-Agent header", async () => {
        const decartWithIntegration = createDecartClient({
          apiKey: TEST_API_KEY,
          baseUrl: BASE_URL,
          integration: "vercel-ai-sdk/3.0.0",
        });

        server.use(createMockHandler("/v1/generate/lucy-pro-t2i"));

        await decartWithIntegration.process({
          model: models.image("lucy-pro-t2i"),
          prompt: "Test with integration",
        });

        const userAgent = lastRequest?.headers.get("user-agent");
        expect(userAgent).toBeDefined();
        expect(userAgent).toContain("vercel-ai-sdk/3.0.0");
        expect(userAgent).toMatch(/^decart-js-sdk\/[\d.]+-?\w* lang\/js vercel-ai-sdk\/3\.0\.0 runtime\/[\w./]+$/);
      });

      it("processes text-to-image with resolution", async () => {
        server.use(createMockHandler("/v1/generate/lucy-pro-t2i"));

        const result = await decart.process({
          model: models.image("lucy-pro-t2i"),
          prompt: "A beautiful landscape",
          seed: 123,
          resolution: "480p",
        });

        expect(result).toBeInstanceOf(Blob);
        expect(lastRequest?.headers.get("x-api-key")).toBe(TEST_API_KEY);
        expect(lastFormData?.get("prompt")).toBe("A beautiful landscape");
        expect(lastFormData?.get("seed")).toBe("123");
        expect(lastFormData?.get("resolution")).toBe("480p");
      });

      it("processes image-to-image", async () => {
        server.use(createMockHandler("/v1/generate/lucy-pro-i2i"));

        const testBlob = new Blob(["test-image"], { type: "image/png" });

        const result = await decart.process({
          model: models.image("lucy-pro-i2i"),
          prompt: "Make it artistic",
          data: testBlob,
        });

        expect(result).toBeInstanceOf(Blob);
        expect(lastRequest?.headers.get("x-api-key")).toBe(TEST_API_KEY);
        expect(lastFormData?.get("prompt")).toBe("Make it artistic");

        const dataFile = lastFormData?.get("data") as File;
        expect(dataFile).toBeInstanceOf(File);
      });
    });

    describe("Abort Signal", () => {
      it("supports abort signal", async () => {
        const controller = new AbortController();

        server.use(
          http.post(`${BASE_URL}/v1/generate/lucy-pro-t2i`, async () => {
            await new Promise((resolve) => setTimeout(resolve, 100));
            return HttpResponse.arrayBuffer(MOCK_RESPONSE_DATA, {
              headers: { "Content-Type": "application/octet-stream" },
            });
          }),
        );

        const processPromise = decart.process({
          model: models.image("lucy-pro-t2i"),
          prompt: "test",
          signal: controller.signal,
        });

        controller.abort();

        await expect(processPromise).rejects.toThrow();
      });
    });

    describe("Input Validation", () => {
      it("validates required inputs for text-to-image", async () => {
        await expect(
          decart.process({
            model: models.image("lucy-pro-t2i"),
            // biome-ignore lint/suspicious/noExplicitAny: testing invalid input
          } as any),
        ).rejects.toThrow("Invalid inputs");
      });

      it("validates required inputs for image-to-image", async () => {
        await expect(
          decart.process({
            model: models.image("lucy-pro-i2i"),
            prompt: "test",
            // biome-ignore lint/suspicious/noExplicitAny: testing invalid input
          } as any),
        ).rejects.toThrow("Invalid inputs");
      });

      it("validates prompt max length is 1000 characters", async () => {
        await expect(
          decart.process({
            model: models.image("lucy-pro-t2i"),
            prompt: "a".repeat(1001),
          }),
        ).rejects.toThrow("expected string to have <=1000 characters");
      });
    });

    describe("Error Handling", () => {
      it("handles API errors", async () => {
        server.use(
          http.post(`${BASE_URL}/v1/generate/lucy-pro-t2i`, () => {
            return HttpResponse.text("Internal Server Error", { status: 500 });
          }),
        );

        await expect(
          decart.process({
            model: models.image("lucy-pro-t2i"),
            prompt: "test",
          }),
        ).rejects.toThrow("Processing failed");
      });
    });
  });
});

describe("Queue API", () => {
  let decart: ReturnType<typeof createDecartClient>;
  let lastFormData: FormData | null = null;
  let lastRequest: Request | null = null;

  const server = setupServer();

  beforeAll(() => {
    server.listen({ onUnhandledRequest: "error" });
  });

  afterAll(() => {
    server.close();
  });

  beforeEach(() => {
    lastFormData = null;
    lastRequest = null;
    decart = createDecartClient({
      apiKey: "test-api-key",
      baseUrl: "http://localhost",
    });
  });

  afterEach(() => {
    server.resetHandlers();
  });

  describe("submit", () => {
    it("submits text-to-video job", async () => {
      server.use(
        http.post("http://localhost/v1/jobs/lucy-pro-t2v", async ({ request }) => {
          lastRequest = request;
          lastFormData = await request.formData();
          return HttpResponse.json({
            job_id: "job_123",
            status: "pending",
          });
        }),
      );

      const result = await decart.queue.submit({
        model: models.video("lucy-pro-t2v"),
        prompt: "A cat playing piano",
        seed: 42,
      });

      expect(result.job_id).toBe("job_123");
      expect(result.status).toBe("pending");
      expect(lastRequest?.headers.get("x-api-key")).toBe("test-api-key");
      expect(lastFormData?.get("prompt")).toBe("A cat playing piano");
      expect(lastFormData?.get("seed")).toBe("42");
    });

    it("submits video-to-video job", async () => {
      server.use(
        http.post("http://localhost/v1/jobs/lucy-pro-v2v", async ({ request }) => {
          lastRequest = request;
          lastFormData = await request.formData();
          return HttpResponse.json({
            job_id: "job_v2v",
            status: "pending",
          });
        }),
      );

      const testBlob = new Blob(["test-video"], { type: "video/mp4" });

      const result = await decart.queue.submit({
        model: models.video("lucy-pro-v2v"),
        prompt: "Make it artistic",
        data: testBlob,
        enhance_prompt: true,
      });

      expect(result.job_id).toBe("job_v2v");
      expect(result.status).toBe("pending");
      expect(lastFormData?.get("prompt")).toBe("Make it artistic");
      expect(lastFormData?.get("enhance_prompt")).toBe("true");

      const dataFile = lastFormData?.get("data") as File;
      expect(dataFile).toBeInstanceOf(File);
    });

    it("submits video-to-video job with optional reference_image", async () => {
      server.use(
        http.post("http://localhost/v1/jobs/lucy-pro-v2v", async ({ request }) => {
          lastRequest = request;
          lastFormData = await request.formData();
          return HttpResponse.json({
            job_id: "job_v2v_ref",
            status: "pending",
          });
        }),
      );

      const testVideoBlob = new Blob(["test-video"], { type: "video/mp4" });
      const testImageBlob = new Blob(["test-image"], { type: "image/png" });

      const result = await decart.queue.submit({
        model: models.video("lucy-pro-v2v"),
        prompt: "Make it artistic",
        data: testVideoBlob,
        reference_image: testImageBlob,
        seed: 123,
      });

      expect(result.job_id).toBe("job_v2v_ref");
      expect(result.status).toBe("pending");
      expect(lastFormData?.get("prompt")).toBe("Make it artistic");
      expect(lastFormData?.get("seed")).toBe("123");

      const dataFile = lastFormData?.get("data") as File;
      expect(dataFile).toBeInstanceOf(File);

      const refImageFile = lastFormData?.get("reference_image") as File;
      expect(refImageFile).toBeInstanceOf(File);
    });

    it("submits video restyle job", async () => {
      server.use(
        http.post("http://localhost/v1/jobs/lucy-restyle-v2v", async ({ request }) => {
          lastRequest = request;
          lastFormData = await request.formData();
          return HttpResponse.json({
            job_id: "job_restyle",
            status: "pending",
          });
        }),
      );

      const testBlob = new Blob(["test-video"], { type: "video/mp4" });

      const result = await decart.queue.submit({
        model: models.video("lucy-restyle-v2v"),
        prompt: "Transform to anime style",
        data: testBlob,
        enhance_prompt: true,
        seed: 42,
      });

      expect(result.job_id).toBe("job_restyle");
      expect(result.status).toBe("pending");
      expect(lastFormData?.get("prompt")).toBe("Transform to anime style");
      expect(lastFormData?.get("enhance_prompt")).toBe("true");
      expect(lastFormData?.get("seed")).toBe("42");

      const dataFile = lastFormData?.get("data") as File;
      expect(dataFile).toBeInstanceOf(File);
    });

    it("submits video restyle job with reference_image", async () => {
      server.use(
        http.post("http://localhost/v1/jobs/lucy-restyle-v2v", async ({ request }) => {
          lastRequest = request;
          lastFormData = await request.formData();
          return HttpResponse.json({
            job_id: "job_restyle_ref",
            status: "pending",
          });
        }),
      );

      const testVideoBlob = new Blob(["test-video"], { type: "video/mp4" });
      const testImageBlob = new Blob(["test-image"], { type: "image/png" });

      const result = await decart.queue.submit({
        model: models.video("lucy-restyle-v2v"),
        reference_image: testImageBlob,
        data: testVideoBlob,
        seed: 123,
      });

      expect(result.job_id).toBe("job_restyle_ref");
      expect(result.status).toBe("pending");
      expect(lastFormData?.get("prompt")).toBeNull();
      expect(lastFormData?.get("seed")).toBe("123");

      const dataFile = lastFormData?.get("data") as File;
      expect(dataFile).toBeInstanceOf(File);

      const refImageFile = lastFormData?.get("reference_image") as File;
      expect(refImageFile).toBeInstanceOf(File);
    });

    it("rejects video restyle job when both prompt and reference_image are provided", async () => {
      const testVideoBlob = new Blob(["test-video"], { type: "video/mp4" });
      const testImageBlob = new Blob(["test-image"], { type: "image/png" });

      await expect(
        decart.queue.submit({
          model: models.video("lucy-restyle-v2v"),
          prompt: "Transform to anime style",
          reference_image: testImageBlob,
          data: testVideoBlob,
        } as Parameters<typeof decart.queue.submit>[0]),
      ).rejects.toThrow("Must provide either 'prompt' or 'reference_image', but not both");
    });

    it("rejects video restyle job when neither prompt nor reference_image is provided", async () => {
      const testVideoBlob = new Blob(["test-video"], { type: "video/mp4" });

      await expect(
        decart.queue.submit({
          model: models.video("lucy-restyle-v2v"),
          data: testVideoBlob,
        } as Parameters<typeof decart.queue.submit>[0]),
      ).rejects.toThrow("Must provide either 'prompt' or 'reference_image', but not both");
    });

    it("rejects video restyle job when enhance_prompt is used with reference_image", async () => {
      const testVideoBlob = new Blob(["test-video"], { type: "video/mp4" });
      const testImageBlob = new Blob(["test-image"], { type: "image/png" });

      await expect(
        decart.queue.submit({
          model: models.video("lucy-restyle-v2v"),
          reference_image: testImageBlob,
          data: testVideoBlob,
          enhance_prompt: true,
        } as Parameters<typeof decart.queue.submit>[0]),
      ).rejects.toThrow("'enhance_prompt' is only valid when using 'prompt', not 'reference_image'");
    });

    it("submits image-to-video job", async () => {
      server.use(
        http.post("http://localhost/v1/jobs/lucy-pro-i2v", async ({ request }) => {
          lastRequest = request;
          lastFormData = await request.formData();
          return HttpResponse.json({
            job_id: "job_i2v",
            status: "pending",
          });
        }),
      );

      const testBlob = new Blob(["test-image"], { type: "image/png" });

      const result = await decart.queue.submit({
        model: models.video("lucy-pro-i2v"),
        prompt: "The image comes to life",
        data: testBlob,
      });

      expect(result.job_id).toBe("job_i2v");
      expect(result.status).toBe("pending");
      expect(lastFormData?.get("prompt")).toBe("The image comes to life");

      const dataFile = lastFormData?.get("data") as File;
      expect(dataFile).toBeInstanceOf(File);
    });

    it("submits first-last-frame-to-video job", async () => {
      server.use(
        http.post("http://localhost/v1/jobs/lucy-pro-flf2v", async ({ request }) => {
          lastRequest = request;
          lastFormData = await request.formData();
          return HttpResponse.json({
            job_id: "job_flf2v",
            status: "pending",
          });
        }),
      );

      const startBlob = new Blob(["start-frame"], { type: "image/png" });
      const endBlob = new Blob(["end-frame"], { type: "image/png" });

      const result = await decart.queue.submit({
        model: models.video("lucy-pro-flf2v"),
        prompt: "Smooth transition",
        start: startBlob,
        end: endBlob,
        seed: 123,
      });

      expect(result.job_id).toBe("job_flf2v");
      expect(result.status).toBe("pending");
      expect(lastFormData?.get("prompt")).toBe("Smooth transition");
      expect(lastFormData?.get("seed")).toBe("123");

      const startFile = lastFormData?.get("start") as File;
      const endFile = lastFormData?.get("end") as File;
      expect(startFile).toBeInstanceOf(File);
      expect(endFile).toBeInstanceOf(File);
    });

    it("submits motion video job", async () => {
      server.use(
        http.post("http://localhost/v1/jobs/lucy-motion", async ({ request }) => {
          lastRequest = request;
          lastFormData = await request.formData();
          return HttpResponse.json({
            job_id: "job_motion",
            status: "pending",
          });
        }),
      );

      const testBlob = new Blob(["test-image"], { type: "image/png" });

      const result = await decart.queue.submit({
        model: models.video("lucy-motion"),
        data: testBlob,
        trajectory: [
          { frame: 0, x: 0, y: 0 },
          { frame: 10, x: 100, y: 100 },
        ],
      });

      expect(result.job_id).toBe("job_motion");
      expect(result.status).toBe("pending");

      const dataFile = lastFormData?.get("data") as File;
      expect(dataFile).toBeInstanceOf(File);
      expect(lastFormData?.get("trajectory")).toBeDefined();
    });

    it("validates required inputs", async () => {
      await expect(
        decart.queue.submit({
          model: models.video("lucy-pro-t2v"),
          // biome-ignore lint/suspicious/noExplicitAny: testing invalid input
        } as any),
      ).rejects.toThrow("Invalid inputs");
    });

    it("validates required inputs for video-to-video", async () => {
      await expect(
        decart.queue.submit({
          model: models.video("lucy-pro-v2v"),
          prompt: "test",
          // biome-ignore lint/suspicious/noExplicitAny: testing invalid input
        } as any),
      ).rejects.toThrow("Invalid inputs");
    });

    it("validates trajectory length is less	 than 1000", async () => {
      const testBlob = new Blob(["test-image"], { type: "image/png" });

      await expect(
        decart.queue.submit({
          model: models.video("lucy-motion"),
          data: testBlob,
          trajectory: Array.from({ length: 1001 }, (_, i) => ({
            frame: i,
            x: 0,
            y: 0,
          })),
        }),
      ).rejects.toThrow("expected array to have <=1000 items");
    });

    it("handles API errors", async () => {
      server.use(
        http.post("http://localhost/v1/jobs/lucy-pro-t2v", () => {
          return HttpResponse.text("Internal Server Error", { status: 500 });
        }),
      );

      await expect(
        decart.queue.submit({
          model: models.video("lucy-pro-t2v"),
          prompt: "test",
        }),
      ).rejects.toThrow("Failed to submit job");
    });
  });

  describe("status", () => {
    it("gets job status", async () => {
      server.use(
        http.get("http://localhost/v1/jobs/job_123", ({ request }) => {
          lastRequest = request;
          return HttpResponse.json({
            job_id: "job_123",
            status: "processing",
          });
        }),
      );

      const result = await decart.queue.status("job_123");

      expect(result.job_id).toBe("job_123");
      expect(result.status).toBe("processing");
      expect(lastRequest?.headers.get("x-api-key")).toBe("test-api-key");
    });

    it("handles API errors", async () => {
      server.use(
        http.get("http://localhost/v1/jobs/job_123", () => {
          return HttpResponse.text("Not Found", { status: 404 });
        }),
      );

      await expect(decart.queue.status("job_123")).rejects.toThrow("Failed to get job status");
    });
  });

  describe("result", () => {
    it("gets job result as blob", async () => {
      server.use(
        http.get("http://localhost/v1/jobs/job_123/content", ({ request }) => {
          lastRequest = request;
          return HttpResponse.arrayBuffer(MOCK_RESPONSE_DATA, {
            headers: { "Content-Type": "video/mp4" },
          });
        }),
      );

      const result = await decart.queue.result("job_123");

      expect(result).toBeInstanceOf(Blob);
      expect(lastRequest?.headers.get("x-api-key")).toBe("test-api-key");
    });

    it("handles API errors", async () => {
      server.use(
        http.get("http://localhost/v1/jobs/job_123/content", () => {
          return HttpResponse.text("Not Found", { status: 404 });
        }),
      );

      await expect(decart.queue.result("job_123")).rejects.toThrow("Failed to get job content");
    });
  });

  describe("submitAndPoll", () => {
    it("submits and polls until completed", async () => {
      let pollCount = 0;
      const statusChanges: Array<{ job_id: string; status: string }> = [];

      server.use(
        http.post("http://localhost/v1/jobs/lucy-pro-t2v", async ({ request }) => {
          lastFormData = await request.formData();
          return HttpResponse.json({
            job_id: "job_456",
            status: "pending",
          });
        }),
        http.get("http://localhost/v1/jobs/job_456", () => {
          pollCount++;
          if (pollCount < 2) {
            return HttpResponse.json({
              job_id: "job_456",
              status: "processing",
            });
          }
          return HttpResponse.json({
            job_id: "job_456",
            status: "completed",
          });
        }),
        http.get("http://localhost/v1/jobs/job_456/content", () => {
          return HttpResponse.arrayBuffer(MOCK_RESPONSE_DATA, {
            headers: { "Content-Type": "video/mp4" },
          });
        }),
      );

      const result = await decart.queue.submitAndPoll({
        model: models.video("lucy-pro-t2v"),
        prompt: "A beautiful sunset",
        onStatusChange: (job) => {
          statusChanges.push({ job_id: job.job_id, status: job.status });
        },
      });

      expect(result.status).toBe("completed");
      if (result.status === "completed") {
        expect(result.data).toBeInstanceOf(Blob);
      }
      expect(statusChanges.length).toBeGreaterThan(0);
      expect(statusChanges[0].job_id).toBe("job_456");
    });

    it("returns failed status when job fails", async () => {
      server.use(
        http.post("http://localhost/v1/jobs/lucy-pro-t2v", () => {
          return HttpResponse.json({
            job_id: "job_789",
            status: "pending",
          });
        }),
        http.get("http://localhost/v1/jobs/job_789", () => {
          return HttpResponse.json({
            job_id: "job_789",
            status: "failed",
          });
        }),
      );

      const result = await decart.queue.submitAndPoll({
        model: models.video("lucy-pro-t2v"),
        prompt: "This will fail",
      });

      expect(result.status).toBe("failed");
      if (result.status === "failed") {
        expect(result.error).toBe("Job failed");
      }
    });

    it("supports abort signal", async () => {
      const controller = new AbortController();

      server.use(
        http.post("http://localhost/v1/jobs/lucy-pro-t2v", () => {
          return HttpResponse.json({
            job_id: "job_abort",
            status: "pending",
          });
        }),
        http.get("http://localhost/v1/jobs/job_abort", async () => {
          await new Promise((resolve) => setTimeout(resolve, 100));
          return HttpResponse.json({
            job_id: "job_abort",
            status: "processing",
          });
        }),
      );

      const pollPromise = decart.queue.submitAndPoll({
        model: models.video("lucy-pro-t2v"),
        prompt: "test",
        signal: controller.signal,
      });

      // Abort after a short delay
      setTimeout(() => controller.abort(), 50);

      await expect(pollPromise).rejects.toThrow();
    });
  });
});

describe("UserAgent", () => {
  it("builds User-Agent with version and runtime", async () => {
    const { buildUserAgent } = await import("../src/utils/user-agent.js");
    const { VERSION } = await import("../src/version.js");

    // Use mock globalThis to avoid navigator.userAgent in Node.js >= 21
    const mockGlobal = {
      process: { versions: { node: true }, version: process.version },
    };
    const userAgent = buildUserAgent(undefined, mockGlobal);

    expect(userAgent).toEqual(`decart-js-sdk/${VERSION} lang/js runtime/node.js/${process.version}`);
  });

  it("builds User-Agent with integration", async () => {
    const { buildUserAgent } = await import("../src/utils/user-agent.js");
    const { VERSION } = await import("../src/version.js");

    // Use mock globalThis to avoid navigator.userAgent in Node.js >= 21
    const mockGlobal = {
      process: { versions: { node: true }, version: process.version },
    };
    const userAgent = buildUserAgent("vercel-ai-sdk/3.0.0", mockGlobal);

    expect(userAgent).toEqual(
      `decart-js-sdk/${VERSION} lang/js vercel-ai-sdk/3.0.0 runtime/node.js/${process.version}`,
    );
  });

  it("detects runtime with custom globalThis", async () => {
    const { getRuntimeEnvironment } = await import("../src/utils/user-agent.js");

    // Test browser detection
    const mockBrowser = { window: {} };
    expect(getRuntimeEnvironment(mockBrowser)).toEqual("runtime/browser");

    // Test Node.js < 21.1 detection (no navigator.userAgent)
    const mockNodeOld = {
      process: { versions: { node: true }, version: "v18.0.0" },
    };
    expect(getRuntimeEnvironment(mockNodeOld)).toEqual("runtime/node.js/v18.0.0");

    // Test Node.js >= 21.1 and other runtimes detection (has navigator.userAgent)
    const mockNodeNew = {
      navigator: { userAgent: "Node.js/v22.0.0" },
    };
    expect(getRuntimeEnvironment(mockNodeNew)).toEqual("runtime/node.js/v22.0.0");

    // Test Vercel Edge detection (no navigator.userAgent, has EdgeRuntime)
    const mockEdge = { EdgeRuntime: true };
    expect(getRuntimeEnvironment(mockEdge)).toEqual("runtime/vercel-edge");

    // Test unknown runtime
    const mockUnknown = {};
    expect(getRuntimeEnvironment(mockUnknown)).toEqual("runtime/unknown");
  });
});

describe("Tokens API", () => {
  let decart: ReturnType<typeof createDecartClient>;
  let lastRequest: Request | null = null;

  const server = setupServer();

  beforeAll(() => {
    server.listen({ onUnhandledRequest: "error" });
  });

  afterAll(() => {
    server.close();
  });

  beforeEach(() => {
    lastRequest = null;
    decart = createDecartClient({
      apiKey: "test-api-key",
      baseUrl: "http://localhost",
    });
  });

  afterEach(() => {
    server.resetHandlers();
  });

  describe("create", () => {
    it("creates a client token", async () => {
      server.use(
        http.post("http://localhost/v1/client/tokens", ({ request }) => {
          lastRequest = request;
          return HttpResponse.json({
            apiKey: "ek_test123",
            expiresAt: "2024-12-15T12:10:00Z",
          });
        }),
      );

      const result = await decart.tokens.create();

      expect(result.apiKey).toBe("ek_test123");
      expect(result.expiresAt).toBe("2024-12-15T12:10:00Z");
      expect(lastRequest?.headers.get("x-api-key")).toBe("test-api-key");
    });

    it("handles 401 error", async () => {
      server.use(
        http.post("http://localhost/v1/client/tokens", () => {
          return HttpResponse.json({ error: "Invalid API key" }, { status: 401 });
        }),
      );

      await expect(decart.tokens.create()).rejects.toThrow("Failed to create token");
    });

    it("handles 403 error", async () => {
      server.use(
        http.post("http://localhost/v1/client/tokens", () => {
          return HttpResponse.json({ error: "Cannot create token from client token" }, { status: 403 });
        }),
      );

      await expect(decart.tokens.create()).rejects.toThrow("Failed to create token");
    });
  });
});

describe("Lucy 2 realtime", () => {
  describe("Model Definition", () => {
    it("has correct model name", () => {
      const lucyModel = models.realtime("lucy_2_rt");
      expect(lucyModel.name).toBe("lucy_2_rt");
    });

    it("has correct URL path", () => {
      const lucyModel = models.realtime("lucy_2_rt");
      expect(lucyModel.urlPath).toBe("/v1/stream");
    });

    it("has expected dimensions", () => {
      const lucyModel = models.realtime("lucy_2_rt");
      expect(lucyModel.width).toBe(1280);
      expect(lucyModel.height).toBe(720);
    });

    it("has correct fps", () => {
      const lucyModel = models.realtime("lucy_2_rt");
      expect(lucyModel.fps).toBe(20);
    });

    it("is recognized as a realtime model", () => {
      expect(models.realtime("lucy_2_rt")).toBeDefined();
    });
  });
});

describe("WebRTCConnection", () => {
  describe("setImageBase64", () => {
    it("rejects immediately when WebSocket is not open", async () => {
      const { WebRTCConnection } = await import("../src/realtime/webrtc-connection.js");
      const connection = new WebRTCConnection();

      await expect(connection.setImageBase64("base64data", { timeout: 5000 })).rejects.toThrow("WebSocket is not open");
    });

    it("rejects immediately with default timeout when WebSocket is not open", async () => {
      const { WebRTCConnection } = await import("../src/realtime/webrtc-connection.js");
      const connection = new WebRTCConnection();

      await expect(connection.setImageBase64("base64data")).rejects.toThrow("WebSocket is not open");
    });

    describe("timeout behavior", () => {
      beforeEach(() => {
        vi.useFakeTimers();
      });

      afterEach(() => {
        vi.useRealTimers();
      });

      it("uses custom timeout when send succeeds but ack is not received", async () => {
        const { WebRTCConnection } = await import("../src/realtime/webrtc-connection.js");
        const connection = new WebRTCConnection();
        const sendSpy = vi.spyOn(connection, "send").mockReturnValue(true);

        const customTimeout = 5000;
        let rejected = false;
        let rejectionError: Error | null = null;

        const promise = connection.setImageBase64("base64data", { timeout: customTimeout }).catch((err) => {
          rejected = true;
          rejectionError = err;
        });

        await vi.advanceTimersByTimeAsync(customTimeout - 1);
        expect(rejected).toBe(false);

        await vi.advanceTimersByTimeAsync(2);
        await promise;

        expect(rejected).toBe(true);
        expect(rejectionError?.message).toBe("Image send timed out");
        sendSpy.mockRestore();
      });

      it("uses default timeout (30000ms) when send succeeds but ack is not received", async () => {
        const { WebRTCConnection } = await import("../src/realtime/webrtc-connection.js");
        const connection = new WebRTCConnection();
        const sendSpy = vi.spyOn(connection, "send").mockReturnValue(true);

        let rejected = false;
        let rejectionError: Error | null = null;

        const promise = connection.setImageBase64("base64data").catch((err) => {
          rejected = true;
          rejectionError = err;
        });

        await vi.advanceTimersByTimeAsync(29999);
        expect(rejected).toBe(false);

        await vi.advanceTimersByTimeAsync(2);
        await promise;

        expect(rejected).toBe(true);
        expect(rejectionError?.message).toBe("Image send timed out");
        sendSpy.mockRestore();
      });
    });
  });

  describe("setupNewPeerConnection", () => {
    it("does not persist TURN servers between peer connection recreations", async () => {
      const { WebRTCConnection } = await import("../src/realtime/webrtc-connection.js");
      const iceServerCounts: number[] = [];

      class FakePeerConnection {
        connectionState: RTCPeerConnectionState = "new";
        iceConnectionState: RTCIceConnectionState = "new";
        ontrack: ((event: RTCTrackEvent) => void) | null = null;
        onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
        onconnectionstatechange: (() => void) | null = null;
        oniceconnectionstatechange: (() => void) | null = null;

        constructor(config: RTCConfiguration) {
          iceServerCounts.push(config.iceServers?.length ?? 0);
        }

        getSenders(): RTCRtpSender[] {
          return [];
        }

        removeTrack(): void {}

        close(): void {}

        addTrack(): RTCRtpSender {
          return {} as RTCRtpSender;
        }

        addTransceiver(): RTCRtpTransceiver {
          return {} as RTCRtpTransceiver;
        }
      }

      vi.stubGlobal("RTCPeerConnection", FakePeerConnection as unknown as typeof RTCPeerConnection);

      try {
        const connection = new WebRTCConnection();
        const internalConnection = connection as unknown as {
          handleSignalingMessage: (msg: unknown) => Promise<void>;
          localStream: { getTracks: () => MediaStreamTrack[] };
          setupNewPeerConnection: (turnConfig?: {
            username: string;
            credential: string;
            server_url: string;
          }) => Promise<void>;
        };

        vi.spyOn(internalConnection, "handleSignalingMessage").mockResolvedValue(undefined);
        internalConnection.localStream = { getTracks: () => [] };

        await internalConnection.setupNewPeerConnection({
          username: "user",
          credential: "secret",
          server_url: "turn:turn.example.com",
        });
        await internalConnection.setupNewPeerConnection();

        expect(iceServerCounts).toEqual([2, 1]);
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });
});

describe("RealTimeClient cleanup", () => {
  it("cleans up AudioStreamManager when avatar fetch fails before WebRTC connect", async () => {
    class FakeAudioContext {
      createMediaStreamDestination() {
        return { stream: {} };
      }
      createOscillator() {
        return { connect: vi.fn(), start: vi.fn(), stop: vi.fn() };
      }
      createGain() {
        return { gain: { value: 0 }, connect: vi.fn() };
      }
      close() {
        return Promise.resolve();
      }
    }

    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: "Not Found",
      }),
    );

    const { AudioStreamManager } = await import("../src/realtime/audio-stream-manager.js");
    const cleanupSpy = vi.spyOn(AudioStreamManager.prototype, "cleanup");

    try {
      const { createRealTimeClient } = await import("../src/realtime/client.js");
      const realtime = createRealTimeClient({ baseUrl: "wss://example.com", apiKey: "test-key" });

      await expect(
        realtime.connect(null, {
          model: models.realtime("live_avatar"),
          onRemoteStream: vi.fn(),
          avatar: { avatarImage: "https://example.com/avatar.png" },
        }),
      ).rejects.toThrow("Failed to fetch image: 404 Not Found");

      expect(cleanupSpy).toHaveBeenCalledTimes(1);
    } finally {
      cleanupSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});

describe("live_avatar Model", () => {
  describe("Model Definition", () => {
    it("has correct model name", () => {
      const avatarModel = models.realtime("live_avatar");
      expect(avatarModel.name).toBe("live_avatar");
    });

    it("has correct URL path for live_avatar", () => {
      const avatarModel = models.realtime("live_avatar");
      expect(avatarModel.urlPath).toBe("/v1/stream");
    });

    it("has expected dimensions", () => {
      const avatarModel = models.realtime("live_avatar");
      expect(avatarModel.width).toBe(1280);
      expect(avatarModel.height).toBe(720);
    });

    it("has correct fps", () => {
      const avatarModel = models.realtime("live_avatar");
      expect(avatarModel.fps).toBe(25);
    });

    it("is recognized as a realtime model", () => {
      expect(models.realtime("live_avatar")).toBeDefined();
    });
  });

  describe("Live_Avatar Message Types", () => {
    it("SetAvatarImageMessage has correct structure", () => {
      const message: import("../src/realtime/types").SetAvatarImageMessage = {
        type: "set_image",
        image_data: "base64encodeddata",
      };

      expect(message.type).toBe("set_image");
      expect(message.image_data).toBe("base64encodeddata");
    });

    it("SetImageAckMessage has correct structure", () => {
      const successMessage: import("../src/realtime/types").SetImageAckMessage = {
        type: "set_image_ack",
        success: true,
        error: null,
      };

      expect(successMessage.type).toBe("set_image_ack");
      expect(successMessage.success).toBe(true);
      expect(successMessage.error).toBeNull();

      const failureMessage: import("../src/realtime/types").SetImageAckMessage = {
        type: "set_image_ack",
        success: false,
        error: "invalid image",
      };

      expect(failureMessage.type).toBe("set_image_ack");
      expect(failureMessage.success).toBe(false);
      expect(failureMessage.error).toBe("invalid image");
    });
  });
});

describe("set()", () => {
  let mockManager: {
    setImage: ReturnType<typeof vi.fn>;
    getWebsocketMessageEmitter: ReturnType<typeof vi.fn>;
    sendMessage: ReturnType<typeof vi.fn>;
    getConnectionState: ReturnType<typeof vi.fn>;
  };
  let mockEmitter: {
    on: ReturnType<typeof vi.fn>;
    off: ReturnType<typeof vi.fn>;
  };
  let mockImageToBase64: ReturnType<typeof vi.fn>;
  let methods: ReturnType<typeof import("../src/realtime/methods.js").realtimeMethods>;

  beforeEach(async () => {
    const { realtimeMethods } = await import("../src/realtime/methods.js");
    mockEmitter = {
      on: vi.fn(),
      off: vi.fn(),
    };
    mockManager = {
      setImage: vi.fn().mockResolvedValue(undefined),
      getWebsocketMessageEmitter: vi.fn().mockReturnValue(mockEmitter),
      sendMessage: vi.fn().mockReturnValue(true),
      getConnectionState: vi.fn().mockReturnValue("connected"),
    };
    mockImageToBase64 = vi.fn().mockResolvedValue("base64data");
    // biome-ignore lint/suspicious/noExplicitAny: testing with mock
    methods = realtimeMethods(mockManager as any, mockImageToBase64);
  });

  it("rejects when neither prompt nor image is provided", async () => {
    await expect(methods.set({})).rejects.toThrow("At least one of 'prompt' or 'image' must be provided");
  });

  it("rejects when not connected", async () => {
    mockManager.getConnectionState.mockReturnValue("disconnected");
    await expect(methods.set({ prompt: "a cat" })).rejects.toThrow("Cannot send message: connection is disconnected");
  });

  it("setPrompt rejects when not connected", async () => {
    mockManager.getConnectionState.mockReturnValue("reconnecting");
    await expect(methods.setPrompt("a cat")).rejects.toThrow("Cannot send message: connection is reconnecting");
  });

  it("setPrompt rejects immediately when send fails", async () => {
    mockManager.sendMessage.mockReturnValue(false);
    await expect(methods.setPrompt("a cat")).rejects.toThrow("WebSocket is not open");
  });

  it("setPrompt resolves on matching ack", async () => {
    let promptAckListener: ((msg: import("../src/realtime/types").PromptAckMessage) => void) | undefined;
    mockEmitter.on.mockImplementation((event, listener) => {
      if (event === "promptAck") {
        promptAckListener = listener;
      }
    });
    mockEmitter.off.mockImplementation((event, listener) => {
      if (event === "promptAck" && promptAckListener === listener) {
        promptAckListener = undefined;
      }
    });

    const promise = methods.setPrompt("a cat", { enhance: false });
    expect(promptAckListener).toBeDefined();
    expect(mockManager.sendMessage).toHaveBeenCalledWith({
      type: "prompt",
      prompt: "a cat",
      enhance_prompt: false,
    });

    promptAckListener?.({
      type: "prompt_ack",
      prompt: "a cat",
      success: true,
      error: null,
    });
    await promise;
    expect(mockEmitter.off).toHaveBeenCalled();
  });

  it("setPrompt rejects with Error when ack reports failure", async () => {
    let promptAckListener: ((msg: import("../src/realtime/types").PromptAckMessage) => void) | undefined;
    mockEmitter.on.mockImplementation((event, listener) => {
      if (event === "promptAck") {
        promptAckListener = listener;
      }
    });

    const promise = methods.setPrompt("a cat");
    expect(promptAckListener).toBeDefined();

    promptAckListener?.({
      type: "prompt_ack",
      prompt: "a cat",
      success: false,
      error: "invalid prompt",
    });

    const error = await promise.catch((err) => err);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("invalid prompt");
  });

  it("rejects when prompt is empty string", async () => {
    await expect(methods.set({ prompt: "" })).rejects.toThrow();
  });

  it("sends only prompt when no image provided", async () => {
    await methods.set({ prompt: "a cat" });
    expect(mockManager.setImage).toHaveBeenCalledWith(null, { prompt: "a cat", enhance: true, timeout: 30000 });
  });

  it("sends prompt with enhance flag", async () => {
    await methods.set({ prompt: "a cat", enhance: true });
    expect(mockManager.setImage).toHaveBeenCalledWith(null, { prompt: "a cat", enhance: true, timeout: 30000 });
  });

  it("sends only image when no prompt provided", async () => {
    mockImageToBase64.mockResolvedValue("convertedbase64");
    await methods.set({ image: "rawbase64data" });

    expect(mockImageToBase64).toHaveBeenCalledWith("rawbase64data");
    expect(mockManager.setImage).toHaveBeenCalledWith("convertedbase64", {
      prompt: undefined,
      enhance: true,
      timeout: 30000,
    });
  });

  it("sends prompt and image together", async () => {
    mockImageToBase64.mockResolvedValue("convertedbase64");
    await methods.set({ prompt: "a cat", enhance: false, image: "rawbase64" });

    expect(mockManager.setImage).toHaveBeenCalledWith("convertedbase64", {
      prompt: "a cat",
      enhance: false,
      timeout: 30000,
    });
  });

  it("converts Blob image to base64", async () => {
    mockImageToBase64.mockResolvedValue("blobbase64");
    const testBlob = new Blob(["test-image"], { type: "image/png" });
    await methods.set({ image: testBlob });

    expect(mockImageToBase64).toHaveBeenCalledWith(testBlob);
    expect(mockManager.setImage).toHaveBeenCalledWith("blobbase64", {
      prompt: undefined,
      enhance: true,
      timeout: 30000,
    });
  });
});

describe("PR1 resilience", () => {
  it("connect resolves when state becomes generating before poll observes connected", async () => {
    const { WebRTCConnection } = await import("../src/realtime/webrtc-connection.js");

    class FakeWebSocket {
      static OPEN = 1;
      static CLOSED = 3;
      readyState = FakeWebSocket.OPEN;
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: (() => void) | null = null;

      constructor(_url: string) {
        setTimeout(() => this.onopen?.(), 0);
      }

      send(): void {}

      close(): void {
        this.readyState = FakeWebSocket.CLOSED;
        this.onclose?.();
      }
    }

    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);

    try {
      const connection = new WebRTCConnection();
      const internal = connection as unknown as {
        setState: (state: import("../src/realtime/types").ConnectionState) => void;
        setupNewPeerConnection: () => Promise<void>;
      };

      vi.spyOn(internal, "setupNewPeerConnection").mockImplementation(async () => {
        internal.setState("connected");
        setTimeout(() => internal.setState("generating"), 0);
      });

      await expect(
        connection.connect("wss://example.com", { getTracks: () => [] } as MediaStream, 750),
      ).resolves.toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("transitions from generating to disconnected when peer connection disconnects", async () => {
    const { WebRTCConnection } = await import("../src/realtime/webrtc-connection.js");

    class FakePeerConnection {
      connectionState: RTCPeerConnectionState = "new";
      iceConnectionState: RTCIceConnectionState = "new";
      ontrack: ((event: RTCTrackEvent) => void) | null = null;
      onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
      onconnectionstatechange: (() => void) | null = null;
      oniceconnectionstatechange: (() => void) | null = null;

      getSenders(): RTCRtpSender[] {
        return [];
      }

      removeTrack(): void {}

      close(): void {}

      addTrack(): RTCRtpSender {
        return {} as RTCRtpSender;
      }

      addTransceiver(): RTCRtpTransceiver {
        return {} as RTCRtpTransceiver;
      }
    }

    vi.stubGlobal("RTCPeerConnection", FakePeerConnection as unknown as typeof RTCPeerConnection);

    try {
      const connection = new WebRTCConnection();
      const internal = connection as unknown as {
        handleSignalingMessage: (msg: unknown) => Promise<void>;
        localStream: { getTracks: () => MediaStreamTrack[] };
        setupNewPeerConnection: () => Promise<void>;
        pc: { connectionState: RTCPeerConnectionState; onconnectionstatechange: (() => void) | null } | null;
      };

      vi.spyOn(internal, "handleSignalingMessage").mockResolvedValue(undefined);
      internal.localStream = { getTracks: () => [] };
      await internal.setupNewPeerConnection();

      connection.state = "generating";
      if (!internal.pc?.onconnectionstatechange) {
        throw new Error("Peer connection state callback was not set");
      }

      internal.pc.connectionState = "disconnected";
      internal.pc.onconnectionstatechange();

      expect(connection.state).toBe("disconnected");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("treats generating as an established connection for reconnect decisions", async () => {
    const { WebRTCManager } = await import("../src/realtime/webrtc-manager.js");
    const manager = new WebRTCManager({
      webrtcUrl: "wss://example.com",
      onRemoteStream: vi.fn(),
      onError: vi.fn(),
    });

    const internal = manager as unknown as {
      handleConnectionStateChange: (state: import("../src/realtime/types").ConnectionState) => void;
      reconnect: () => Promise<void>;
    };

    const reconnectSpy = vi.spyOn(internal, "reconnect").mockResolvedValue(undefined);
    try {
      internal.handleConnectionStateChange("generating");
      internal.handleConnectionStateChange("disconnected");
      expect(reconnectSpy).toHaveBeenCalledTimes(1);
    } finally {
      reconnectSpy.mockRestore();
    }
  });

  it("replays connection events emitted during connect before returning client", async () => {
    const { createRealTimeClient } = await import("../src/realtime/client.js");
    const { WebRTCManager } = await import("../src/realtime/webrtc-manager.js");

    const promptAckListeners = new Set<(msg: import("../src/realtime/types").PromptAckMessage) => void>();
    const websocketEmitter = {
      on: (event: string, listener: (msg: import("../src/realtime/types").PromptAckMessage) => void) => {
        if (event === "promptAck") promptAckListeners.add(listener);
      },
      off: (event: string, listener: (msg: import("../src/realtime/types").PromptAckMessage) => void) => {
        if (event === "promptAck") promptAckListeners.delete(listener);
      },
    };

    const connectSpy = vi.spyOn(WebRTCManager.prototype, "connect").mockImplementation(async function () {
      const manager = this as unknown as {
        config: { onConnectionStateChange?: (state: import("../src/realtime/types").ConnectionState) => void };
        managerState: import("../src/realtime/types").ConnectionState;
      };
      manager.managerState = "connected";
      manager.config.onConnectionStateChange?.("connected");
      return true;
    });
    const stateSpy = vi.spyOn(WebRTCManager.prototype, "getConnectionState").mockImplementation(function () {
      const manager = this as unknown as { managerState: import("../src/realtime/types").ConnectionState };
      return manager.managerState ?? "connected";
    });
    const emitterSpy = vi
      .spyOn(WebRTCManager.prototype, "getWebsocketMessageEmitter")
      .mockReturnValue(websocketEmitter as never);
    const sendSpy = vi.spyOn(WebRTCManager.prototype, "sendMessage").mockImplementation(function (message) {
      if (message.type === "prompt") {
        setTimeout(() => {
          const manager = this as unknown as {
            config: { onConnectionStateChange?: (state: import("../src/realtime/types").ConnectionState) => void };
            managerState: import("../src/realtime/types").ConnectionState;
          };
          manager.managerState = "generating";
          manager.config.onConnectionStateChange?.("generating");
          for (const listener of promptAckListeners) {
            listener({
              type: "prompt_ack",
              prompt: message.prompt,
              success: true,
              error: null,
            });
          }
        }, 0);
      }
      return true;
    });
    const cleanupSpy = vi.spyOn(WebRTCManager.prototype, "cleanup").mockImplementation(() => {});

    try {
      const realtime = createRealTimeClient({ baseUrl: "wss://example.com", apiKey: "test-key" });
      const client = await realtime.connect({} as MediaStream, {
        model: models.realtime("mirage_v2"),
        onRemoteStream: vi.fn(),
        initialState: {
          prompt: {
            text: "test",
          },
        },
      });

      const states: import("../src/realtime/types").ConnectionState[] = [];
      client.on("connectionChange", (state) => states.push(state));

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(states).toEqual(["connected", "generating"]);
    } finally {
      connectSpy.mockRestore();
      stateSpy.mockRestore();
      emitterSpy.mockRestore();
      sendSpy.mockRestore();
      cleanupSpy.mockRestore();
    }
  });
});
