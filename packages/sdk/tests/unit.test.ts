import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
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

    it("throws an error if api key is empty string", () => {
      expect(() => createDecartClient({ apiKey: "" })).toThrow("Missing API key");
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
        num_inference_steps: 50,
      });

      expect(result.job_id).toBe("job_v2v");
      expect(result.status).toBe("pending");
      expect(lastFormData?.get("prompt")).toBe("Make it artistic");
      expect(lastFormData?.get("enhance_prompt")).toBe("true");
      expect(lastFormData?.get("num_inference_steps")).toBe("50");

      const dataFile = lastFormData?.get("data") as File;
      expect(dataFile).toBeInstanceOf(File);
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

describe("Avatar-Live Model", () => {
  describe("Model Definition", () => {
    it("has correct model name", () => {
      const avatarModel = models.realtime("avatar-live");
      expect(avatarModel.name).toBe("avatar-live");
    });

    it("has correct URL path for avatar-live", () => {
      const avatarModel = models.realtime("avatar-live");
      expect(avatarModel.urlPath).toBe("/v1/avatar-live/stream");
    });

    it("has expected dimensions", () => {
      const avatarModel = models.realtime("avatar-live");
      expect(avatarModel.width).toBe(1280);
      expect(avatarModel.height).toBe(720);
    });

    it("has correct fps", () => {
      const avatarModel = models.realtime("avatar-live");
      expect(avatarModel.fps).toBe(25);
    });

    it("is recognized as a realtime model", () => {
      expect(models.realtime("avatar-live")).toBeDefined();
    });
  });

  describe("Avatar-Live Message Types", () => {
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
