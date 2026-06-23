import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as publicSdk from "../src/index.js";
import {
  type CanonicalModel,
  createDecartClient,
  isCanonicalModel,
  isModel,
  isRealtimeModel,
  isVideoModel,
  type ListedModelDefinition,
  listModels,
  type ModelKind,
  modelAliases,
  models,
  resolveCanonicalModelAlias,
  resolveModelAlias,
} from "../src/index.js";
import {
  _resetDeprecationWarnings,
  canonicalImageModels,
  canonicalModelSchema,
  canonicalRealtimeModels,
  canonicalVideoModels,
  imageModels,
  modelSchema,
  realtimeModels,
  videoModels,
} from "../src/shared/model.js";

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

    it("throws an error if invalid realtimeBaseUrl is provided", () => {
      expect(() => createDecartClient({ apiKey: "test", realtimeBaseUrl: "not-a-url" })).toThrow("Invalid base URL");
    });

    it("creates a client with custom realtimeBaseUrl", () => {
      const decart = createDecartClient({
        apiKey: "test",
        realtimeBaseUrl: "wss://custom-ws.example.com",
      });
      expect(decart).toBeDefined();
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
      it("processes image-to-image", async () => {
        server.use(createMockHandler("/v1/generate/lucy-pro-i2i"));

        const testBlob = new Blob(["test-image"], { type: "image/png" });

        const result = await decart.process({
          model: models.image("lucy-pro-i2i"),
          prompt: "A cat playing piano",
          data: testBlob,
          seed: 42,
        });

        expect(result).toBeInstanceOf(Blob);
        expect(lastRequest?.headers.get("x-api-key")).toBe(TEST_API_KEY);
        expect(lastFormData?.get("prompt")).toBe("A cat playing piano");
        expect(lastFormData?.get("seed")).toBe("42");
      });

      it("includes User-Agent header in requests", async () => {
        server.use(createMockHandler("/v1/generate/lucy-pro-i2i"));

        const testBlob = new Blob(["test-image"], { type: "image/png" });

        await decart.process({
          model: models.image("lucy-pro-i2i"),
          prompt: "Test prompt",
          data: testBlob,
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

        server.use(createMockHandler("/v1/generate/lucy-pro-i2i"));

        const testBlob = new Blob(["test-image"], { type: "image/png" });

        await decartWithIntegration.process({
          model: models.image("lucy-pro-i2i"),
          prompt: "Test with integration",
          data: testBlob,
        });

        const userAgent = lastRequest?.headers.get("user-agent");
        expect(userAgent).toBeDefined();
        expect(userAgent).toContain("vercel-ai-sdk/3.0.0");
        expect(userAgent).toMatch(/^decart-js-sdk\/[\d.]+-?\w* lang\/js vercel-ai-sdk\/3\.0\.0 runtime\/[\w./]+$/);
      });

      it("processes image-to-image with resolution", async () => {
        server.use(createMockHandler("/v1/generate/lucy-pro-i2i"));

        const testBlob = new Blob(["test-image"], { type: "image/png" });

        const result = await decart.process({
          model: models.image("lucy-pro-i2i"),
          prompt: "A beautiful landscape",
          data: testBlob,
          seed: 123,
          resolution: "480p",
        });

        expect(result).toBeInstanceOf(Blob);
        expect(lastRequest?.headers.get("x-api-key")).toBe(TEST_API_KEY);
        expect(lastFormData?.get("prompt")).toBe("A beautiful landscape");
        expect(lastFormData?.get("seed")).toBe("123");
        expect(lastFormData?.get("resolution")).toBe("480p");
      });

      it("processes image-to-image with enhance_prompt", async () => {
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

      it("processes image-to-image with reference_image", async () => {
        server.use(createMockHandler("/v1/generate/lucy-pro-i2i"));

        const testBlob = new Blob(["test-image"], { type: "image/png" });
        const testRefBlob = new Blob(["test-ref-image"], { type: "image/png" });

        const result = await decart.process({
          model: models.image("lucy-pro-i2i"),
          prompt: "Add the hat from the reference image",
          data: testBlob,
          reference_image: testRefBlob,
          seed: 42,
        });

        expect(result).toBeInstanceOf(Blob);
        expect(lastFormData?.get("prompt")).toBe("Add the hat from the reference image");
        expect(lastFormData?.get("seed")).toBe("42");

        const dataFile = lastFormData?.get("data") as File;
        expect(dataFile).toBeInstanceOf(File);

        const refImageFile = lastFormData?.get("reference_image") as File;
        expect(refImageFile).toBeInstanceOf(File);
      });
    });

    describe("Abort Signal", () => {
      it("supports abort signal", async () => {
        const controller = new AbortController();

        server.use(
          http.post(`${BASE_URL}/v1/generate/lucy-pro-i2i`, async () => {
            await new Promise((resolve) => setTimeout(resolve, 100));
            return HttpResponse.arrayBuffer(MOCK_RESPONSE_DATA, {
              headers: { "Content-Type": "application/octet-stream" },
            });
          }),
        );

        const testBlob = new Blob(["test-image"], { type: "image/png" });

        const processPromise = decart.process({
          model: models.image("lucy-pro-i2i"),
          prompt: "test",
          data: testBlob,
          signal: controller.signal,
        });

        controller.abort();

        await expect(processPromise).rejects.toThrow();
      });
    });

    describe("Input Validation", () => {
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
        const testBlob = new Blob(["test-image"], { type: "image/png" });

        await expect(
          decart.process({
            model: models.image("lucy-pro-i2i"),
            prompt: "a".repeat(1001),
            data: testBlob,
          }),
        ).rejects.toThrow("expected string to have <=1000 characters");
      });
    });

    describe("Error Handling", () => {
      it("handles API errors", async () => {
        server.use(
          http.post(`${BASE_URL}/v1/generate/lucy-pro-i2i`, () => {
            return HttpResponse.text("Internal Server Error", { status: 500 });
          }),
        );

        const testBlob = new Blob(["test-image"], { type: "image/png" });

        await expect(
          decart.process({
            model: models.image("lucy-pro-i2i"),
            prompt: "test",
            data: testBlob,
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

    it("submits lucy-2.1 job with prompt", async () => {
      server.use(
        http.post("http://localhost/v1/jobs/lucy-2.1", async ({ request }) => {
          lastRequest = request;
          lastFormData = await request.formData();
          return HttpResponse.json({
            job_id: "job_lucy2_v2v",
            status: "pending",
          });
        }),
      );

      const testBlob = new Blob(["test-video"], { type: "video/mp4" });

      const result = await decart.queue.submit({
        model: models.video("lucy-2.1"),
        prompt: "Transform the scene",
        data: testBlob,
        enhance_prompt: true,
        seed: 42,
      });

      expect(result.job_id).toBe("job_lucy2_v2v");
      expect(result.status).toBe("pending");
      expect(lastFormData?.get("prompt")).toBe("Transform the scene");
      expect(lastFormData?.get("enhance_prompt")).toBe("true");
      expect(lastFormData?.get("seed")).toBe("42");

      const dataFile = lastFormData?.get("data") as File;
      expect(dataFile).toBeInstanceOf(File);
    });

    it("submits lucy-2.1 job with empty prompt and reference_image", async () => {
      server.use(
        http.post("http://localhost/v1/jobs/lucy-2.1", async ({ request }) => {
          lastRequest = request;
          lastFormData = await request.formData();
          return HttpResponse.json({
            job_id: "job_lucy2_v2v_refonly",
            status: "pending",
          });
        }),
      );

      const testVideoBlob = new Blob(["test-video"], { type: "video/mp4" });
      const testImageBlob = new Blob(["test-image"], { type: "image/png" });

      const result = await decart.queue.submit({
        model: models.video("lucy-2.1"),
        prompt: "",
        data: testVideoBlob,
        reference_image: testImageBlob,
      });

      expect(result.job_id).toBe("job_lucy2_v2v_refonly");
      expect(result.status).toBe("pending");
      expect(lastFormData?.get("prompt")).toBe("");

      const dataFile = lastFormData?.get("data") as File;
      expect(dataFile).toBeInstanceOf(File);

      const refImageFile = lastFormData?.get("reference_image") as File;
      expect(refImageFile).toBeInstanceOf(File);
    });

    it("submits lucy-2.1 job with reference_image", async () => {
      server.use(
        http.post("http://localhost/v1/jobs/lucy-2.1", async ({ request }) => {
          lastRequest = request;
          lastFormData = await request.formData();
          return HttpResponse.json({
            job_id: "job_lucy2_v2v_ref",
            status: "pending",
          });
        }),
      );

      const testVideoBlob = new Blob(["test-video"], { type: "video/mp4" });
      const testImageBlob = new Blob(["test-image"], { type: "image/png" });

      const result = await decart.queue.submit({
        model: models.video("lucy-2.1"),
        prompt: "Transform the scene",
        data: testVideoBlob,
        reference_image: testImageBlob,
        seed: 123,
      });

      expect(result.job_id).toBe("job_lucy2_v2v_ref");
      expect(result.status).toBe("pending");
      expect(lastFormData?.get("prompt")).toBe("Transform the scene");
      expect(lastFormData?.get("seed")).toBe("123");

      const dataFile = lastFormData?.get("data") as File;
      expect(dataFile).toBeInstanceOf(File);

      const refImageFile = lastFormData?.get("reference_image") as File;
      expect(refImageFile).toBeInstanceOf(File);
    });

    it("validates required data input for lucy-2.1", async () => {
      await expect(
        decart.queue.submit({
          model: models.video("lucy-2.1"),
          prompt: "test",
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

    it("handles API errors", async () => {
      server.use(
        http.post("http://localhost/v1/jobs/lucy-pro-v2v", () => {
          return HttpResponse.text("Internal Server Error", { status: 500 });
        }),
      );

      const testBlob = new Blob(["test-video"], { type: "video/mp4" });

      await expect(
        decart.queue.submit({
          model: models.video("lucy-pro-v2v"),
          prompt: "test",
          data: testBlob,
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
        http.post("http://localhost/v1/jobs/lucy-pro-v2v", async ({ request }) => {
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

      const testBlob = new Blob(["test-video"], { type: "video/mp4" });

      const result = await decart.queue.submitAndPoll({
        model: models.video("lucy-pro-v2v"),
        prompt: "A beautiful sunset",
        data: testBlob,
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
        http.post("http://localhost/v1/jobs/lucy-pro-v2v", () => {
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

      const testBlob = new Blob(["test-video"], { type: "video/mp4" });

      const result = await decart.queue.submitAndPoll({
        model: models.video("lucy-pro-v2v"),
        prompt: "This will fail",
        data: testBlob,
      });

      expect(result.status).toBe("failed");
      if (result.status === "failed") {
        expect(result.error).toBe("Job failed");
      }
    });

    it("supports abort signal", async () => {
      const controller = new AbortController();

      server.use(
        http.post("http://localhost/v1/jobs/lucy-pro-v2v", () => {
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

      const testBlob = new Blob(["test-video"], { type: "video/mp4" });

      const pollPromise = decart.queue.submitAndPoll({
        model: models.video("lucy-pro-v2v"),
        prompt: "test",
        data: testBlob,
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

    it("sends metadata when provided", async () => {
      server.use(
        http.post("http://localhost/v1/client/tokens", async ({ request }) => {
          lastRequest = request;
          return HttpResponse.json({
            apiKey: "ek_test123",
            expiresAt: "2024-12-15T12:10:00Z",
          });
        }),
      );

      const result = await decart.tokens.create({ metadata: { role: "viewer" } });

      expect(result.apiKey).toBe("ek_test123");
      const body = await lastRequest?.json();
      expect(body).toEqual({ metadata: { role: "viewer" } });
      expect(lastRequest?.headers.get("content-type")).toBe("application/json");
    });

    it("sends JSON body without metadata when none provided", async () => {
      server.use(
        http.post("http://localhost/v1/client/tokens", async ({ request }) => {
          lastRequest = request;
          return HttpResponse.json({
            apiKey: "ek_test123",
            expiresAt: "2024-12-15T12:10:00Z",
          });
        }),
      );

      await decart.tokens.create();

      expect(lastRequest?.headers.get("content-type")).toBe("application/json");
      const body = await lastRequest?.text();
      expect(body).toBeDefined();
      expect(JSON.parse(body ?? "")).toEqual({});
    });

    it("sends expiresIn in request body", async () => {
      server.use(
        http.post("http://localhost/v1/client/tokens", async ({ request }) => {
          lastRequest = request;
          return HttpResponse.json({
            apiKey: "ek_test123",
            expiresAt: "2024-12-15T12:15:00Z",
          });
        }),
      );

      await decart.tokens.create({ expiresIn: 300 });

      const body = await lastRequest?.json();
      expect(body).toEqual({ expiresIn: 300 });
    });

    it("sends allowedModels in request body", async () => {
      server.use(
        http.post("http://localhost/v1/client/tokens", async ({ request }) => {
          lastRequest = request;
          return HttpResponse.json({
            apiKey: "ek_test123",
            expiresAt: "2024-12-15T12:10:00Z",
          });
        }),
      );

      await decart.tokens.create({ allowedModels: ["lucy-pro-v2v", "lucy-restyle-v2v"] });

      const body = await lastRequest?.json();
      expect(body).toEqual({ allowedModels: ["lucy-pro-v2v", "lucy-restyle-v2v"] });
    });

    it("sends constraints in request body", async () => {
      server.use(
        http.post("http://localhost/v1/client/tokens", async ({ request }) => {
          lastRequest = request;
          return HttpResponse.json({
            apiKey: "ek_test123",
            expiresAt: "2024-12-15T12:10:00Z",
          });
        }),
      );

      await decart.tokens.create({ constraints: { realtime: { maxSessionDuration: 120 } } });

      const body = await lastRequest?.json();
      expect(body).toEqual({ constraints: { realtime: { maxSessionDuration: 120 } } });
    });

    it("sends allowedOrigins in request body", async () => {
      server.use(
        http.post("http://localhost/v1/client/tokens", async ({ request }) => {
          lastRequest = request;
          return HttpResponse.json({
            apiKey: "ek_test123",
            expiresAt: "2024-12-15T12:10:00Z",
          });
        }),
      );

      await decart.tokens.create({ allowedOrigins: ["https://example.com", "https://app.example.com"] });

      const body = await lastRequest?.json();
      expect(body).toEqual({ allowedOrigins: ["https://example.com", "https://app.example.com"] });
    });

    it("sends all options together", async () => {
      server.use(
        http.post("http://localhost/v1/client/tokens", async ({ request }) => {
          lastRequest = request;
          return HttpResponse.json({
            apiKey: "ek_test123",
            expiresAt: "2024-12-15T12:15:00Z",
          });
        }),
      );

      await decart.tokens.create({
        metadata: { role: "viewer" },
        expiresIn: 300,
        allowedModels: ["lucy-pro-v2v"],
        allowedOrigins: ["https://example.com"],
        constraints: { realtime: { maxSessionDuration: 60 } },
      });

      const body = await lastRequest?.json();
      expect(body).toEqual({
        metadata: { role: "viewer" },
        expiresIn: 300,
        allowedModels: ["lucy-pro-v2v"],
        allowedOrigins: ["https://example.com"],
        constraints: { realtime: { maxSessionDuration: 60 } },
      });
    });

    it("returns all fields from response", async () => {
      server.use(
        http.post("http://localhost/v1/client/tokens", () => {
          return HttpResponse.json({
            apiKey: "ek_test123",
            token: "eyJhbGciOiJFZERTQS.signed.jwt",
            expiresAt: "2024-12-15T12:15:00Z",
            permissions: {
              models: ["lucy-pro-v2v", "lucy-restyle-v2v"],
              origins: ["https://example.com"],
            },
            constraints: { realtime: { maxSessionDuration: 120 } },
          });
        }),
      );

      const result = await decart.tokens.create({
        allowedModels: ["lucy-pro-v2v", "lucy-restyle-v2v"],
        allowedOrigins: ["https://example.com"],
        constraints: { realtime: { maxSessionDuration: 120 } },
      });

      expect(result).toEqual({
        apiKey: "ek_test123",
        token: "eyJhbGciOiJFZERTQS.signed.jwt",
        expiresAt: "2024-12-15T12:15:00Z",
        permissions: {
          models: ["lucy-pro-v2v", "lucy-restyle-v2v"],
          origins: ["https://example.com"],
        },
        constraints: { realtime: { maxSessionDuration: 120 } },
      });
    });
  });
});

describe("Files API", () => {
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

  describe("upload", () => {
    it("uploads a Blob and returns a FileReference", async () => {
      server.use(
        http.post("http://localhost/v1/files", async ({ request }) => {
          lastRequest = request;
          return HttpResponse.json({
            id: "file_abc123",
            filename: "blob",
            mime_type: "image/png",
            size_bytes: 4,
            created_at: "2026-01-01T00:00:00Z",
            expires_at: "2026-01-02T00:00:00Z",
          });
        }),
      );

      const blob = new Blob([new Uint8Array([0, 1, 2, 3])], { type: "image/png" });
      const ref = await decart.files.upload(blob);

      expect(ref.id).toBe("file_abc123");
      expect(ref.mime_type).toBe("image/png");
      expect(lastRequest?.headers.get("x-api-key")).toBe("test-api-key");
      // Content-Type starts with multipart/form-data when uploading a Blob
      expect(lastRequest?.headers.get("content-type") ?? "").toContain("multipart/form-data");
    });

    it("throws on non-2xx upload", async () => {
      server.use(
        http.post("http://localhost/v1/files", () => {
          return HttpResponse.json({ detail: "Too big" }, { status: 413 });
        }),
      );

      await expect(decart.files.upload(new Blob(["x"]))).rejects.toThrow("Failed to upload file");
    });

    it("rejects bad ttlSeconds locally without hitting the network", async () => {
      let hit = false;
      server.use(
        http.post("http://localhost/v1/files", () => {
          hit = true;
          return HttpResponse.json({}, { status: 200 });
        }),
      );

      await expect(
        // @ts-expect-error – intentionally invalid value
        decart.files.upload(new Blob(["x"]), { ttlSeconds: "forever" }),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });

      await expect(decart.files.upload(new Blob(["x"]), { ttlSeconds: 30 })).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });

      expect(hit).toBe(false);
    });

    it("forwards a numeric ttlSeconds", async () => {
      let receivedForm: FormData | null = null;
      server.use(
        http.post("http://localhost/v1/files", async ({ request }) => {
          receivedForm = await request.formData();
          return HttpResponse.json({
            id: "file_abc",
            filename: null,
            mime_type: "image/png",
            size_bytes: 1,
            created_at: "2026-01-01T00:00:00Z",
            expires_at: "2026-01-01T01:00:00Z",
          });
        }),
      );
      await decart.files.upload(new Blob(["x"]), { ttlSeconds: 3600 });
      expect(receivedForm?.get("ttl_seconds")).toBe("3600");
    });

    it('forwards ttlSeconds="persistent" verbatim', async () => {
      let receivedForm: FormData | null = null;
      server.use(
        http.post("http://localhost/v1/files", async ({ request }) => {
          receivedForm = await request.formData();
          return HttpResponse.json({
            id: "file_abc",
            filename: null,
            mime_type: "image/png",
            size_bytes: 1,
            created_at: "2026-01-01T00:00:00Z",
            expires_at: null,
          });
        }),
      );
      const ref = await decart.files.upload(new Blob(["x"]), { ttlSeconds: "persistent" });
      expect(receivedForm?.get("ttl_seconds")).toBe("persistent");
      expect(ref.expires_at).toBeNull();
    });
  });

  describe("get", () => {
    it("fetches metadata for a file id", async () => {
      server.use(
        http.get("http://localhost/v1/files/file_abc123", () => {
          return HttpResponse.json({
            id: "file_abc123",
            filename: "portrait.png",
            mime_type: "image/png",
            size_bytes: 1234,
            created_at: "2026-01-01T00:00:00Z",
            expires_at: "2026-01-02T00:00:00Z",
          });
        }),
      );

      const ref = await decart.files.get("file_abc123");
      expect(ref.id).toBe("file_abc123");
      expect(ref.filename).toBe("portrait.png");
    });

    it("throws on 404", async () => {
      server.use(
        http.get("http://localhost/v1/files/file_missing", () => {
          return HttpResponse.json({ detail: "File not found" }, { status: 404 });
        }),
      );

      await expect(decart.files.get("file_missing")).rejects.toThrow("Failed to get file");
    });
  });

  describe("delete", () => {
    it("resolves on 204", async () => {
      server.use(
        http.delete("http://localhost/v1/files/file_abc123", () => {
          return new HttpResponse(null, { status: 204 });
        }),
      );

      await expect(decart.files.delete("file_abc123")).resolves.toBeUndefined();
    });

    it("throws on non-2xx", async () => {
      server.use(
        http.delete("http://localhost/v1/files/file_missing", () => {
          return HttpResponse.json({ detail: "File not found" }, { status: 404 });
        }),
      );

      await expect(decart.files.delete("file_missing")).rejects.toThrow("Failed to delete file");
    });
  });
});

describe("Logger", () => {
  it("noopLogger does nothing", async () => {
    const { noopLogger } = await import("../src/utils/logger.js");
    // Should not throw
    noopLogger.debug("test");
    noopLogger.info("test");
    noopLogger.warn("test");
    noopLogger.error("test");
  });

  it("createConsoleLogger filters by level", async () => {
    const { createConsoleLogger } = await import("../src/utils/logger.js");
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const logger = createConsoleLogger("warn");
      logger.debug("d");
      logger.info("i");
      logger.warn("w");
      logger.error("e");

      expect(debugSpy).not.toHaveBeenCalled();
      expect(infoSpy).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledTimes(1);
    } finally {
      debugSpy.mockRestore();
      infoSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("createConsoleLogger at debug level logs everything", async () => {
    const { createConsoleLogger } = await import("../src/utils/logger.js");
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const logger = createConsoleLogger("debug");
      logger.debug("d");
      logger.info("i");
      logger.warn("w");
      logger.error("e");

      expect(debugSpy).toHaveBeenCalledTimes(1);
      expect(infoSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledTimes(1);
    } finally {
      debugSpy.mockRestore();
      infoSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("createConsoleLogger includes data in log output", async () => {
    const { createConsoleLogger } = await import("../src/utils/logger.js");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const logger = createConsoleLogger("warn");
      logger.warn("test message", { key: "value" });

      expect(warnSpy).toHaveBeenCalledWith("[DecartSDK]", "test message", { key: "value" });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("createConsoleLogger defaults to warn level", async () => {
    const { createConsoleLogger } = await import("../src/utils/logger.js");
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const logger = createConsoleLogger();
      logger.info("should not appear");
      logger.warn("should appear");

      expect(infoSpy).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      infoSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});

describe("WebRTCStatsCollector", () => {
  it("starts and stops polling", async () => {
    const { WebRTCStatsCollector } = await import("../src/realtime/observability/webrtc-stats.js");
    const collector = new WebRTCStatsCollector();

    const mockPC = {
      getStats: vi.fn().mockResolvedValue(new Map()),
    } as unknown as RTCPeerConnection;

    const onStats = vi.fn();

    collector.start(mockPC, onStats);
    expect(collector.isRunning()).toBe(true);

    collector.stop();
    expect(collector.isRunning()).toBe(false);
  });

  it("parses inbound video stats", async () => {
    const { WebRTCStatsCollector } = await import("../src/realtime/observability/webrtc-stats.js");

    vi.useFakeTimers();
    try {
      const collector = new WebRTCStatsCollector({ intervalMs: 1000 });

      const videoReport = {
        type: "inbound-rtp",
        kind: "video",
        framesDecoded: 100,
        framesDropped: 2,
        framesPerSecond: 30,
        frameWidth: 1280,
        frameHeight: 720,
        bytesReceived: 500000,
        packetsReceived: 1000,
        packetsLost: 5,
        jitter: 0.01,
        freezeCount: 0,
        totalFreezesDuration: 0,
      };

      const statsReport = new Map([["video-1", videoReport]]);
      const mockPC = {
        getStats: vi.fn().mockResolvedValue(statsReport),
      } as unknown as RTCPeerConnection;

      const receivedStats: Array<import("../src/realtime/observability/webrtc-stats.js").WebRTCStats> = [];
      collector.start(mockPC, (stats) => receivedStats.push(stats));

      await vi.advanceTimersByTimeAsync(1000);

      expect(receivedStats.length).toBe(1);
      const stats = receivedStats[0];
      expect(stats.video).not.toBeNull();
      expect(stats.video?.framesDecoded).toBe(100);
      expect(stats.video?.framesDropped).toBe(2);
      expect(stats.video?.framesPerSecond).toBe(30);
      expect(stats.video?.frameWidth).toBe(1280);
      expect(stats.video?.frameHeight).toBe(720);
      expect(stats.video?.packetsLost).toBe(5);
      expect(stats.audio).toBeNull();
      expect(stats.connection.currentRoundTripTime).toBeNull();

      collector.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("parses inbound audio and candidate-pair stats", async () => {
    const { WebRTCStatsCollector } = await import("../src/realtime/observability/webrtc-stats.js");

    vi.useFakeTimers();
    try {
      const collector = new WebRTCStatsCollector({ intervalMs: 1000 });

      const audioReport = {
        type: "inbound-rtp",
        kind: "audio",
        bytesReceived: 10000,
        packetsReceived: 200,
        packetsLost: 1,
        jitter: 0.005,
      };

      const candidatePairReport = {
        type: "candidate-pair",
        state: "succeeded",
        currentRoundTripTime: 0.05,
        availableOutgoingBitrate: 2000000,
      };

      const statsReport = new Map([
        ["audio-1", audioReport],
        ["cp-1", candidatePairReport],
      ]);
      const mockPC = {
        getStats: vi.fn().mockResolvedValue(statsReport),
      } as unknown as RTCPeerConnection;

      const receivedStats: Array<import("../src/realtime/observability/webrtc-stats.js").WebRTCStats> = [];
      collector.start(mockPC, (stats) => receivedStats.push(stats));

      await vi.advanceTimersByTimeAsync(1000);

      expect(receivedStats.length).toBe(1);
      const stats = receivedStats[0];
      expect(stats.audio).not.toBeNull();
      expect(stats.audio?.packetsLost).toBe(1);
      expect(stats.connection.currentRoundTripTime).toBe(0.05);
      expect(stats.connection.availableOutgoingBitrate).toBe(2000000);

      collector.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("computes video bitrate from bytesReceived delta", async () => {
    const { WebRTCStatsCollector } = await import("../src/realtime/observability/webrtc-stats.js");

    vi.useFakeTimers();
    try {
      const collector = new WebRTCStatsCollector({ intervalMs: 1000 });

      let bytesReceived = 0;
      const mockPC = {
        getStats: vi.fn().mockImplementation(async () => {
          bytesReceived += 125000; // 125KB per second = ~1Mbps
          return new Map([
            [
              "video-1",
              {
                type: "inbound-rtp",
                kind: "video",
                bytesReceived,
                framesDecoded: 0,
                framesDropped: 0,
                framesPerSecond: 0,
                frameWidth: 0,
                frameHeight: 0,
                packetsReceived: 0,
                packetsLost: 0,
                jitter: 0,
                freezeCount: 0,
                totalFreezesDuration: 0,
              },
            ],
          ]);
        }),
      } as unknown as RTCPeerConnection;

      const receivedStats: Array<import("../src/realtime/observability/webrtc-stats.js").WebRTCStats> = [];
      collector.start(mockPC, (stats) => receivedStats.push(stats));

      // First tick: no previous data, bitrate = 0
      await vi.advanceTimersByTimeAsync(1000);
      expect(receivedStats[0].video?.bitrate).toBe(0);

      // Second tick: has delta, should compute bitrate
      await vi.advanceTimersByTimeAsync(1000);
      expect(receivedStats[1].video?.bitrate).toBeGreaterThan(0);

      collector.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("enforces minimum interval of 500ms", async () => {
    const { WebRTCStatsCollector } = await import("../src/realtime/observability/webrtc-stats.js");

    vi.useFakeTimers();
    try {
      const collector = new WebRTCStatsCollector({ intervalMs: 100 }); // Below minimum

      const mockPC = {
        getStats: vi.fn().mockResolvedValue(new Map()),
      } as unknown as RTCPeerConnection;

      const onStats = vi.fn();
      collector.start(mockPC, onStats);

      // At 100ms, nothing should fire (minimum is 500ms)
      await vi.advanceTimersByTimeAsync(100);
      expect(onStats).not.toHaveBeenCalled();

      // At 500ms, it should fire
      await vi.advanceTimersByTimeAsync(400);
      expect(onStats).toHaveBeenCalledTimes(1);

      collector.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops silently if getStats throws", async () => {
    const { WebRTCStatsCollector } = await import("../src/realtime/observability/webrtc-stats.js");

    vi.useFakeTimers();
    try {
      const collector = new WebRTCStatsCollector({ intervalMs: 1000 });

      const mockPC = {
        getStats: vi.fn().mockRejectedValue(new Error("PC closed")),
      } as unknown as RTCPeerConnection;

      const onStats = vi.fn();
      collector.start(mockPC, onStats);

      await vi.advanceTimersByTimeAsync(1000);

      expect(onStats).not.toHaveBeenCalled();
      expect(collector.isRunning()).toBe(false);

      collector.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("TelemetryReporter", () => {
  it("buffers stats and diagnostics then flushes on interval", async () => {
    const { TelemetryReporter } = await import("../src/realtime/observability/telemetry-reporter.js");

    vi.useFakeTimers();

    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const reporter = new TelemetryReporter({
        apiKey: "test-key",
        sessionId: "sess-1",
        logger: { debug() {}, info() {}, warn() {}, error() {} },
        reportIntervalMs: 5000,
      });

      reporter.start();

      reporter.addStats({
        timestamp: 1000,
        video: null,
        audio: null,
        connection: { currentRoundTripTime: null, availableOutgoingBitrate: null },
      });
      reporter.addDiagnostic({
        name: "client-session-connection-breakdown",
        data: { attempt: 1, success: true, totalDurationMs: 500, phases: [] },
        timestamp: 1000,
      });

      // Before interval: no fetch
      expect(fetchMock).not.toHaveBeenCalled();

      // After interval: flush
      await vi.advanceTimersByTimeAsync(5000);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, options] = fetchMock.mock.calls[0];
      expect(url).toBe("https://platform.decart.ai/api/v1/telemetry");
      expect(options.method).toBe("POST");

      const body = JSON.parse(options.body);
      expect(body.sessionId).toBe("sess-1");
      expect(body.stats).toHaveLength(1);
      expect(body.diagnostics).toHaveLength(1);
      expect(body.diagnostics[0].name).toBe("client-session-connection-breakdown");

      reporter.stop();
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("does not send empty reports", async () => {
    const { TelemetryReporter } = await import("../src/realtime/observability/telemetry-reporter.js");

    vi.useFakeTimers();

    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const reporter = new TelemetryReporter({
        apiKey: "test-key",
        sessionId: "sess-1",
        logger: { debug() {}, info() {}, warn() {}, error() {} },
        reportIntervalMs: 5000,
      });

      reporter.start();

      // No data added — interval fires
      await vi.advanceTimersByTimeAsync(5000);

      expect(fetchMock).not.toHaveBeenCalled();

      reporter.stop();
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("stop sends final report with keepalive", async () => {
    const { TelemetryReporter } = await import("../src/realtime/observability/telemetry-reporter.js");

    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const reporter = new TelemetryReporter({
        apiKey: "test-key",
        sessionId: "sess-2",
        logger: { debug() {}, info() {}, warn() {}, error() {} },
      });

      reporter.start();

      reporter.addStats({
        timestamp: 2000,
        video: null,
        audio: null,
        connection: { currentRoundTripTime: null, availableOutgoingBitrate: null },
      });

      reporter.stop();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, options] = fetchMock.mock.calls[0];
      expect(url).toBe("https://platform.decart.ai/api/v1/telemetry");
      expect(options.keepalive).toBe(true);

      const body = JSON.parse(options.body);
      expect(body.sessionId).toBe("sess-2");
      expect(body.stats).toHaveLength(1);

      // flush() after stop() should be a no-op because stop drained the buffers.
      reporter.flush();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("only uses keepalive on the last stop chunk", async () => {
    const { TelemetryReporter } = await import("../src/realtime/observability/telemetry-reporter.js");

    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const reporter = new TelemetryReporter({
        apiKey: "test-key",
        sessionId: "sess-chunk-stop",
        logger: { debug() {}, info() {}, warn() {}, error() {} },
      });

      for (let i = 0; i < 150; i++) {
        reporter.addStats({
          timestamp: i,
          video: null,
          audio: null,
          connection: { currentRoundTripTime: null, availableOutgoingBitrate: null },
        });
      }

      reporter.stop();

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0][1].keepalive).toBeUndefined();
      expect(fetchMock.mock.calls[1][1].keepalive).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not use keepalive when the stop payload is too large", async () => {
    const { TelemetryReporter } = await import("../src/realtime/observability/telemetry-reporter.js");

    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const reporter = new TelemetryReporter({
        apiKey: "test-key",
        sessionId: "sess-large-stop",
        logger: { debug() {}, info() {}, warn() {}, error() {} },
      });

      reporter.addDiagnostic({
        name: "client-session-connection-breakdown",
        data: { message: "x".repeat(70 * 1024) },
        timestamp: 1000,
      });

      reporter.stop();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][1].keepalive).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("silently handles fetch failures", async () => {
    const { TelemetryReporter } = await import("../src/realtime/observability/telemetry-reporter.js");

    const fetchMock = vi.fn().mockRejectedValue(new Error("network error"));
    vi.stubGlobal("fetch", fetchMock);

    try {
      const reporter = new TelemetryReporter({
        apiKey: "test-key",
        sessionId: "sess-3",
        logger: { debug() {}, info() {}, warn() {}, error() {} },
      });

      reporter.addStats({
        timestamp: 3000,
        video: null,
        audio: null,
        connection: { currentRoundTripTime: null, availableOutgoingBitrate: null },
      });

      // Should not throw
      reporter.flush();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("includes auth headers and sdk version in report", async () => {
    const { TelemetryReporter } = await import("../src/realtime/observability/telemetry-reporter.js");

    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const reporter = new TelemetryReporter({
        apiKey: "my-api-key",
        sessionId: "sess-4",
        integration: "test-integration",
        logger: { debug() {}, info() {}, warn() {}, error() {} },
      });

      reporter.addStats({
        timestamp: 4000,
        video: null,
        audio: null,
        connection: { currentRoundTripTime: null, availableOutgoingBitrate: null },
      });

      reporter.flush();

      const [, options] = fetchMock.mock.calls[0];
      expect(options.headers["X-API-KEY"]).toBe("my-api-key");
      expect(options.headers["Content-Type"]).toBe("application/json");

      const body = JSON.parse(options.body);
      expect(body.sdkVersion).toBeDefined();
      expect(typeof body.sdkVersion).toBe("string");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("clears buffers after sending", async () => {
    const { TelemetryReporter } = await import("../src/realtime/observability/telemetry-reporter.js");

    vi.useFakeTimers();

    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const reporter = new TelemetryReporter({
        apiKey: "test-key",
        sessionId: "sess-5",
        logger: { debug() {}, info() {}, warn() {}, error() {} },
        reportIntervalMs: 5000,
      });

      reporter.start();

      reporter.addStats({
        timestamp: 1000,
        video: null,
        audio: null,
        connection: { currentRoundTripTime: null, availableOutgoingBitrate: null },
      });

      // First flush
      await vi.advanceTimersByTimeAsync(5000);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Second interval: no new data, should not send
      await vi.advanceTimersByTimeAsync(5000);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      reporter.stop();
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("chunks reports when buffers exceed 120 items", async () => {
    const { TelemetryReporter } = await import("../src/realtime/observability/telemetry-reporter.js");

    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const reporter = new TelemetryReporter({
        apiKey: "test-key",
        sessionId: "sess-chunk",
        logger: { debug() {}, info() {}, warn() {}, error() {} },
      });

      // Add 150 stats (exceeds max of 120)
      for (let i = 0; i < 150; i++) {
        reporter.addStats({
          timestamp: i,
          video: null,
          audio: null,
          connection: { currentRoundTripTime: null, availableOutgoingBitrate: null },
        });
      }

      reporter.flush();

      // Should produce 2 requests: 120 + 30
      expect(fetchMock).toHaveBeenCalledTimes(2);

      const body1 = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body1.stats).toHaveLength(120);

      const body2 = JSON.parse(fetchMock.mock.calls[1][1].body);
      expect(body2.stats).toHaveLength(30);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("silences non-2xx telemetry responses", async () => {
    const { TelemetryReporter } = await import("../src/realtime/observability/telemetry-reporter.js");

    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: "Internal Server Error" });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const warnMock = vi.fn();
      const reporter = new TelemetryReporter({
        apiKey: "test-key",
        sessionId: "sess-warn",
        logger: { debug() {}, info() {}, warn: warnMock, error() {} },
      });

      reporter.addStats({
        timestamp: 1000,
        video: null,
        audio: null,
        connection: { currentRoundTripTime: null, availableOutgoingBitrate: null },
      });

      reporter.flush();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(warnMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("includes model in report body and tags when provided", async () => {
    const { TelemetryReporter } = await import("../src/realtime/observability/telemetry-reporter.js");

    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const reporter = new TelemetryReporter({
        apiKey: "test-key",
        sessionId: "sess-model",
        model: "gemini-3n",
        logger: { debug() {}, info() {}, warn() {}, error() {} },
      });

      reporter.addStats({
        timestamp: 1000,
        video: null,
        audio: null,
        connection: { currentRoundTripTime: null, availableOutgoingBitrate: null },
      });

      reporter.flush();

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.model).toBe("gemini-3n");
      expect(body.tags.model).toBe("gemini-3n");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("omits model from report when not provided", async () => {
    const { TelemetryReporter } = await import("../src/realtime/observability/telemetry-reporter.js");

    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const reporter = new TelemetryReporter({
        apiKey: "test-key",
        sessionId: "sess-no-model",
        logger: { debug() {}, info() {}, warn() {}, error() {} },
      });

      reporter.addStats({
        timestamp: 1000,
        video: null,
        audio: null,
        connection: { currentRoundTripTime: null, availableOutgoingBitrate: null },
      });

      reporter.flush();

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.model).toBeUndefined();
      expect(body.tags.model).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("NullTelemetryReporter", () => {
  it("all methods are no-ops", async () => {
    const { NullTelemetryReporter } = await import("../src/realtime/observability/telemetry-reporter.js");
    const reporter = new NullTelemetryReporter();

    // None of these should throw
    reporter.start();
    reporter.addStats({
      timestamp: 1000,
      video: null,
      audio: null,
      outboundVideo: null,
      connection: { currentRoundTripTime: null, availableOutgoingBitrate: null },
    });
    reporter.addDiagnostic({ name: "client-session-connection-breakdown", data: {}, timestamp: 1000 });
    reporter.flush();
    reporter.stop();
  });

  it("implements ITelemetryReporter interface", async () => {
    const { NullTelemetryReporter } = await import("../src/realtime/observability/telemetry-reporter.js");
    const reporter = new NullTelemetryReporter();

    expect(typeof reporter.start).toBe("function");
    expect(typeof reporter.addStats).toBe("function");
    expect(typeof reporter.addDiagnostic).toBe("function");
    expect(typeof reporter.flush).toBe("function");
    expect(typeof reporter.stop).toBe("function");
  });
});

describe("Outbound Video Stats", () => {
  it("parses outbound-rtp video with quality limitation tracking", async () => {
    const { WebRTCStatsCollector } = await import("../src/realtime/observability/webrtc-stats.js");

    vi.useFakeTimers();
    try {
      const collector = new WebRTCStatsCollector({ intervalMs: 1000 });

      const outboundVideoReport = {
        type: "outbound-rtp",
        kind: "video",
        bytesSent: 200000,
        packetsSent: 500,
        framesPerSecond: 30,
        frameWidth: 1280,
        frameHeight: 720,
        qualityLimitationReason: "bandwidth",
        qualityLimitationDurations: { none: 5.0, bandwidth: 2.5, cpu: 0, other: 0 },
      };

      const statsReport = new Map([["outbound-video-1", outboundVideoReport]]);
      const mockPC = {
        getStats: vi.fn().mockResolvedValue(statsReport),
      } as unknown as RTCPeerConnection;

      const receivedStats: Array<import("../src/realtime/observability/webrtc-stats.js").WebRTCStats> = [];
      collector.start(mockPC, (stats) => receivedStats.push(stats));

      await vi.advanceTimersByTimeAsync(1000);

      expect(receivedStats.length).toBe(1);
      const stats = receivedStats[0];
      expect(stats.outboundVideo).not.toBeNull();
      expect(stats.outboundVideo?.qualityLimitationReason).toBe("bandwidth");
      expect(stats.outboundVideo?.qualityLimitationDurations).toEqual({
        none: 5.0,
        bandwidth: 2.5,
        cpu: 0,
        other: 0,
      });
      expect(stats.outboundVideo?.framesPerSecond).toBe(30);
      expect(stats.outboundVideo?.frameWidth).toBe(1280);

      collector.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns null outboundVideo when no outbound-rtp report", async () => {
    const { WebRTCStatsCollector } = await import("../src/realtime/observability/webrtc-stats.js");

    vi.useFakeTimers();
    try {
      const collector = new WebRTCStatsCollector({ intervalMs: 1000 });

      const mockPC = {
        getStats: vi.fn().mockResolvedValue(new Map()),
      } as unknown as RTCPeerConnection;

      const receivedStats: Array<import("../src/realtime/observability/webrtc-stats.js").WebRTCStats> = [];
      collector.start(mockPC, (stats) => receivedStats.push(stats));

      await vi.advanceTimersByTimeAsync(1000);

      expect(receivedStats[0].outboundVideo).toBeNull();

      collector.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("computes outbound video bitrate from bytesSent delta", async () => {
    const { WebRTCStatsCollector } = await import("../src/realtime/observability/webrtc-stats.js");

    vi.useFakeTimers();
    try {
      const collector = new WebRTCStatsCollector({ intervalMs: 1000 });

      let bytesSent = 0;
      const mockPC = {
        getStats: vi.fn().mockImplementation(async () => {
          bytesSent += 62500; // 62.5KB per second = ~500kbps
          return new Map([
            [
              "outbound-video-1",
              {
                type: "outbound-rtp",
                kind: "video",
                bytesSent,
                packetsSent: 0,
                framesPerSecond: 30,
                frameWidth: 640,
                frameHeight: 480,
                qualityLimitationReason: "none",
                qualityLimitationDurations: {},
              },
            ],
          ]);
        }),
      } as unknown as RTCPeerConnection;

      const receivedStats: Array<import("../src/realtime/observability/webrtc-stats.js").WebRTCStats> = [];
      collector.start(mockPC, (stats) => receivedStats.push(stats));

      // First tick: no previous data, bitrate = 0
      await vi.advanceTimersByTimeAsync(1000);
      expect(receivedStats[0].outboundVideo?.bitrate).toBe(0);

      // Second tick: has delta
      await vi.advanceTimersByTimeAsync(1000);
      expect(receivedStats[1].outboundVideo?.bitrate).toBeGreaterThan(0);

      collector.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Delta computation for cumulative counters", () => {
  it("computes packetsLostDelta, framesDroppedDelta, freezeCountDelta, freezeDurationDelta", async () => {
    const { WebRTCStatsCollector } = await import("../src/realtime/observability/webrtc-stats.js");

    vi.useFakeTimers();
    try {
      const collector = new WebRTCStatsCollector({ intervalMs: 1000 });

      let packetsLost = 0;
      let framesDropped = 0;
      let freezeCount = 0;
      let totalFreezesDuration = 0;

      const mockPC = {
        getStats: vi.fn().mockImplementation(async () => {
          packetsLost += 3;
          framesDropped += 2;
          freezeCount += 1;
          totalFreezesDuration += 0.5;
          return new Map([
            [
              "inbound-video-1",
              {
                type: "inbound-rtp",
                kind: "video",
                bytesReceived: 100000,
                packetsReceived: 500,
                packetsLost,
                framesDecoded: 100,
                framesDropped,
                framesPerSecond: 30,
                frameWidth: 1280,
                frameHeight: 720,
                jitter: 0.01,
                freezeCount,
                totalFreezesDuration,
              },
            ],
          ]);
        }),
      } as unknown as RTCPeerConnection;

      const receivedStats: Array<import("../src/realtime/observability/webrtc-stats.js").WebRTCStats> = [];
      collector.start(mockPC, (stats) => receivedStats.push(stats));

      // First tick: delta = cumulative (since prev was 0)
      await vi.advanceTimersByTimeAsync(1000);
      expect(receivedStats[0].video?.packetsLostDelta).toBe(3);
      expect(receivedStats[0].video?.framesDroppedDelta).toBe(2);
      expect(receivedStats[0].video?.freezeCountDelta).toBe(1);
      expect(receivedStats[0].video?.freezeDurationDelta).toBe(0.5);

      // Second tick: delta = increment from previous
      await vi.advanceTimersByTimeAsync(1000);
      expect(receivedStats[1].video?.packetsLostDelta).toBe(3);
      expect(receivedStats[1].video?.framesDroppedDelta).toBe(2);
      expect(receivedStats[1].video?.freezeCountDelta).toBe(1);
      expect(receivedStats[1].video?.freezeDurationDelta).toBe(0.5);

      collector.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("computes audio packetsLostDelta", async () => {
    const { WebRTCStatsCollector } = await import("../src/realtime/observability/webrtc-stats.js");

    vi.useFakeTimers();
    try {
      const collector = new WebRTCStatsCollector({ intervalMs: 1000 });

      let audioPacketsLost = 0;
      const mockPC = {
        getStats: vi.fn().mockImplementation(async () => {
          audioPacketsLost += 5;
          return new Map([
            [
              "inbound-audio-1",
              {
                type: "inbound-rtp",
                kind: "audio",
                bytesReceived: 50000,
                packetsReceived: 200,
                packetsLost: audioPacketsLost,
                jitter: 0.02,
              },
            ],
          ]);
        }),
      } as unknown as RTCPeerConnection;

      const receivedStats: Array<import("../src/realtime/observability/webrtc-stats.js").WebRTCStats> = [];
      collector.start(mockPC, (stats) => receivedStats.push(stats));

      await vi.advanceTimersByTimeAsync(1000);
      expect(receivedStats[0].audio?.packetsLostDelta).toBe(5);

      await vi.advanceTimersByTimeAsync(1000);
      expect(receivedStats[1].audio?.packetsLostDelta).toBe(5);

      collector.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clamps deltas to zero if cumulative counter resets", async () => {
    const { WebRTCStatsCollector } = await import("../src/realtime/observability/webrtc-stats.js");

    vi.useFakeTimers();
    try {
      const collector = new WebRTCStatsCollector({ intervalMs: 1000 });

      let packetsLost = 10;
      const mockPC = {
        getStats: vi.fn().mockImplementation(async () => {
          const current = packetsLost;
          // Simulate counter reset on second call
          if (mockPC.getStats.mock.calls.length === 2) {
            packetsLost = 0;
          }
          return new Map([
            [
              "inbound-video-1",
              {
                type: "inbound-rtp",
                kind: "video",
                bytesReceived: 100000,
                packetsReceived: 500,
                packetsLost: current,
                framesDecoded: 100,
                framesDropped: 0,
                framesPerSecond: 30,
                frameWidth: 1280,
                frameHeight: 720,
                jitter: 0.01,
                freezeCount: 0,
                totalFreezesDuration: 0,
              },
            ],
          ]);
        }),
      } as unknown as RTCPeerConnection;

      const receivedStats: Array<import("../src/realtime/observability/webrtc-stats.js").WebRTCStats> = [];
      collector.start(mockPC, (stats) => receivedStats.push(stats));

      await vi.advanceTimersByTimeAsync(1000);
      expect(receivedStats[0].video?.packetsLostDelta).toBe(10);

      // Counter reset: 0 - 10 = -10, clamped to 0
      await vi.advanceTimersByTimeAsync(1000);
      expect(receivedStats[1].video?.packetsLostDelta).toBe(0);

      collector.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("VideoStall Diagnostic", () => {
  it("videoStall event type exists in DiagnosticEvents", async () => {
    // Type-level check: videoStall is a valid DiagnosticEventName
    const event: import("../src/realtime/observability/diagnostics.js").DiagnosticEvent = {
      name: "videoStall",
      data: { stalled: true, durationMs: 0 },
    };
    expect(event.name).toBe("videoStall");
    expect(event.data.stalled).toBe(true);
    expect(event.data.durationMs).toBe(0);
  });

  it("videoStall recovery includes duration", () => {
    const event: import("../src/realtime/observability/diagnostics.js").DiagnosticEvent = {
      name: "videoStall",
      data: { stalled: false, durationMs: 1500 },
    };
    expect(event.data.stalled).toBe(false);
    expect(event.data.durationMs).toBe(1500);
  });
});

describe("CustomModelDefinition", () => {
  it("allows arbitrary model names in modelDefinitionSchema", async () => {
    const { modelDefinitionSchema } = await import("../src/shared/model.js");

    const customModel = {
      name: "lucy_2_rt_preview",
      urlPath: "/v1/stream",
      fps: 20,
      width: 1280,
      height: 720,
    };

    const result = modelDefinitionSchema.safeParse(customModel);
    expect(result.success).toBe(true);
  });

  it("rejects invalid custom model definitions", async () => {
    const { modelDefinitionSchema } = await import("../src/shared/model.js");

    const invalidModel = {
      name: "my_custom_model",
      urlPath: "/v1/stream",
      // missing fps, width, height
    };

    const result = modelDefinitionSchema.safeParse(invalidModel);
    expect(result.success).toBe(false);
  });
});

describe("Canonical Model Names", () => {
  describe("Public model registry exports", () => {
    const latestAliases = [
      "lucy-latest",
      "lucy-vton-latest",
      "lucy-restyle-latest",
      "lucy-clip-latest",
      "lucy-image-latest",
    ];
    const deprecatedAliases = [
      "mirage_v2",
      "lucy-vton",
      "lucy-2.1-vton-2",
      "lucy-pro-v2v",
      "lucy-restyle-v2v",
      "lucy-pro-i2i",
    ];

    it("canonical schemas exclude deprecated and latest aliases", () => {
      for (const alias of [...latestAliases, ...deprecatedAliases]) {
        expect(canonicalModelSchema.safeParse(alias).success).toBe(false);
      }

      expect(canonicalRealtimeModels.options).toEqual([
        "lucy-2.1",
        "lucy-2.1-vton",
        "lucy-vton-2",
        "lucy-vton-3",
        "lucy-restyle-2",
      ]);
      expect(canonicalVideoModels.options).toEqual([
        "lucy-clip",
        "lucy-2.1",
        "lucy-2.1-vton",
        "lucy-vton-2",
        "lucy-vton-3",
        "lucy-restyle-2",
      ]);
      expect(canonicalImageModels.options).toEqual(["lucy-image-2"]);
      expect(canonicalRealtimeModels.safeParse("lucy-2.1").success).toBe(true);
      expect(canonicalRealtimeModels.safeParse("lucy-latest").success).toBe(false);
      expect(canonicalVideoModels.safeParse("lucy-clip").success).toBe(true);
      expect(canonicalVideoModels.safeParse("lucy-pro-v2v").success).toBe(false);
      expect(canonicalImageModels.safeParse("lucy-image-2").success).toBe(true);
      expect(canonicalImageModels.safeParse("lucy-image-latest").success).toBe(false);
    });

    it("public model schemas still accept deprecated and latest aliases", () => {
      for (const model of [...latestAliases, ...deprecatedAliases]) {
        expect(modelSchema.safeParse(model).success).toBe(true);
      }

      expect(realtimeModels.safeParse("lucy-latest").success).toBe(true);
      expect(realtimeModels.safeParse("mirage_v2").success).toBe(true);
      expect(videoModels.safeParse("lucy-clip-latest").success).toBe(true);
      expect(videoModels.safeParse("lucy-pro-v2v").success).toBe(true);
      expect(imageModels.safeParse("lucy-image-latest").success).toBe(true);
      expect(imageModels.safeParse("lucy-pro-i2i").success).toBe(true);
    });

    it("resolves model aliases while preserving accepted latest aliases", () => {
      expect(modelAliases["lucy-pro-v2v"]).toBe("lucy-clip");
      expect(resolveModelAlias("lucy-pro-v2v")).toBe("lucy-clip");
      expect(resolveModelAlias("lucy-clip")).toBe("lucy-clip");
      expect(resolveModelAlias("lucy-latest")).toBe("lucy-latest");
      expect(resolveModelAlias("unknown-model")).toBeUndefined();
    });

    it("resolves only stable canonical names for canonical alias resolution", () => {
      expect(resolveCanonicalModelAlias("lucy-pro-v2v")).toBe("lucy-clip");
      expect(resolveCanonicalModelAlias("lucy-clip")).toBe("lucy-clip");
      expect(resolveCanonicalModelAlias("lucy-latest")).toBeUndefined();
      expect(resolveCanonicalModelAlias("unknown-model")).toBeUndefined();
    });

    it("validates models through public helper functions instead of root zod exports", () => {
      expect(isModel("lucy-latest")).toBe(true);
      expect(isModel("unknown-model")).toBe(false);
      expect(isCanonicalModel("lucy-clip")).toBe(true);
      expect(isCanonicalModel("lucy-latest")).toBe(false);
    });

    it("does not emit deprecation warnings from alias resolution helpers", () => {
      _resetDeprecationWarnings();
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      expect(resolveModelAlias("lucy-pro-v2v")).toBe("lucy-clip");
      expect(resolveCanonicalModelAlias("lucy-pro-v2v")).toBe("lucy-clip");
      expect(warnSpy).not.toHaveBeenCalled();

      warnSpy.mockRestore();
    });

    it("lists all models when called without options", () => {
      const listedModels = listModels();

      expect(listedModels).toHaveLength(28);
      expect(listedModels.some((model) => model.kind === "realtime" && model.name === "lucy-2.1")).toBe(true);
      expect(listedModels.some((model) => model.kind === "video" && model.name === "lucy-clip")).toBe(true);
      expect(listedModels.some((model) => model.kind === "image" && model.name === "lucy-image-2")).toBe(true);
    });

    it("filters by kind without excluding latest or deprecated aliases", () => {
      const realtimeModels = listModels({ kind: "realtime" });
      const realtimeNames = realtimeModels.map((model) => model.name);

      expect(realtimeModels.every((model) => model.kind === "realtime")).toBe(true);
      expect(realtimeNames).toContain("lucy-latest");
      expect(realtimeNames).toContain("mirage_v2");
    });

    it("lists canonical model definitions without latest or deprecated aliases", () => {
      const listedModels = listModels({ canonicalOnly: true });
      const listedNames = listedModels.map((model) => model.name);

      for (const alias of [...latestAliases, ...deprecatedAliases]) {
        expect(listedNames).not.toContain(alias);
      }
      expect(listedModels.every((model) => canonicalModelSchema.safeParse(model.name).success)).toBe(true);
    });

    it("preserves model kind for dual-kind canonical names", () => {
      const lucyModels = listModels({ canonicalOnly: true }).filter((model) => model.name === "lucy-2.1");

      expect(lucyModels).toHaveLength(2);
      expect(lucyModels.map((model) => model.kind).sort()).toEqual(["realtime", "video"]);
    });

    it("supports consumer-style imports from the package root", () => {
      const kind: ModelKind = "video";
      const canonicalModel: CanonicalModel = resolveCanonicalModelAlias("lucy-pro-v2v") ?? "lucy-clip";
      const listedModels: ListedModelDefinition[] = listModels({ kind, canonicalOnly: true });

      expect(canonicalModel).toBe("lucy-clip");
      expect(isCanonicalModel(canonicalModel)).toBe(true);
      expect(listedModels.every((model) => model.kind === kind)).toBe(true);
    });

    it("does not expose raw zod schemas from the package root", () => {
      expect("canonicalModelSchema" in publicSdk).toBe(false);
      expect("canonicalRealtimeModels" in publicSdk).toBe(false);
      expect("canonicalVideoModels" in publicSdk).toBe(false);
      expect("canonicalImageModels" in publicSdk).toBe(false);
      expect("modelSchema" in publicSdk).toBe(false);
      expect("realtimeModels" in publicSdk).toBe(false);
      expect("videoModels" in publicSdk).toBe(false);
      expect("imageModels" in publicSdk).toBe(false);
      expect("modelInputSchemas" in publicSdk).toBe(false);
      expect("modelDefinitionSchema" in publicSdk).toBe(false);
    });
  });

  describe("Realtime canonical models", () => {
    it("lucy-2.1 canonical name works", () => {
      const model = models.realtime("lucy-2.1");
      expect(model.name).toBe("lucy-2.1");
      expect(model.urlPath).toBe("/v1/stream");
      expect(model.fps).toEqual({ ideal: 30, max: 30 });
      expect(model.width).toBe(1088);
      expect(model.height).toBe(624);
    });

    it("lucy-2.1-vton canonical name works", () => {
      const model = models.realtime("lucy-2.1-vton");
      expect(model.name).toBe("lucy-2.1-vton");
      expect(model.urlPath).toBe("/v1/stream");
      expect(model.fps).toEqual({ ideal: 30, max: 30 });
      expect(model.width).toBe(1088);
      expect(model.height).toBe(624);
    });

    it("lucy-vton-2 canonical name works", () => {
      const model = models.realtime("lucy-vton-2");
      expect(model.name).toBe("lucy-vton-2");
      expect(model.urlPath).toBe("/v1/stream");
      expect(model.fps).toEqual({ ideal: 30, max: 30 });
      expect(model.width).toBe(1088);
      expect(model.height).toBe(624);
    });

    it("lucy-vton-3 canonical name works", () => {
      const model = models.realtime("lucy-vton-3");
      expect(model.name).toBe("lucy-vton-3");
      expect(model.urlPath).toBe("/v1/stream");
      expect(model.fps).toEqual({ ideal: 30, max: 30 });
      expect(model.width).toBe(1088);
      expect(model.height).toBe(624);
    });

    it("lucy-restyle-2 canonical name works", () => {
      const model = models.realtime("lucy-restyle-2");
      expect(model.name).toBe("lucy-restyle-2");
      expect(model.fps).toEqual({ ideal: 30, max: 30 });
    });
  });

  describe("Video canonical models", () => {
    it("lucy-clip canonical name works", () => {
      const model = models.video("lucy-clip");
      expect(model.name).toBe("lucy-clip");
      expect(model.urlPath).toBe("/v1/generate/lucy-clip");
      expect(model.queueUrlPath).toBe("/v1/jobs/lucy-clip");
      expect(model.fps).toBe(25);
    });

    it("lucy-2.1 as video model works", () => {
      const model = models.video("lucy-2.1");
      expect(model.name).toBe("lucy-2.1");
      expect(model.urlPath).toBe("/v1/generate/lucy-2.1");
      expect(model.queueUrlPath).toBe("/v1/jobs/lucy-2.1");
      expect(model.fps).toBe(20);
    });

    it("lucy-2.1-vton as video model works", () => {
      const model = models.video("lucy-2.1-vton");
      expect(model.name).toBe("lucy-2.1-vton");
      expect(model.urlPath).toBe("/v1/generate/lucy-2.1-vton");
      expect(model.queueUrlPath).toBe("/v1/jobs/lucy-2.1-vton");
    });

    it("lucy-vton-2 as video model works", () => {
      const model = models.video("lucy-vton-2");
      expect(model.name).toBe("lucy-vton-2");
      expect(model.urlPath).toBe("/v1/generate/lucy-vton-2");
      expect(model.queueUrlPath).toBe("/v1/jobs/lucy-vton-2");
      expect(model.fps).toBe(20);
      expect(model.width).toBe(1088);
      expect(model.height).toBe(624);
    });

    it("lucy-vton-3 as video model works", () => {
      const model = models.video("lucy-vton-3");
      expect(model.name).toBe("lucy-vton-3");
      expect(model.urlPath).toBe("/v1/generate/lucy-vton-3");
      expect(model.queueUrlPath).toBe("/v1/jobs/lucy-vton-3");
      expect(model.fps).toBe(20);
      expect(model.width).toBe(1088);
      expect(model.height).toBe(624);
    });

    it("lucy-restyle-2 as video model works", () => {
      const model = models.video("lucy-restyle-2");
      expect(model.name).toBe("lucy-restyle-2");
      expect(model.urlPath).toBe("/v1/generate/lucy-restyle-2");
      expect(model.queueUrlPath).toBe("/v1/jobs/lucy-restyle-2");
    });
  });

  describe("Image canonical models", () => {
    it("lucy-image-2 canonical name works", () => {
      const model = models.image("lucy-image-2");
      expect(model.name).toBe("lucy-image-2");
      expect(model.urlPath).toBe("/v1/generate/lucy-image-2");
      expect(model.queueUrlPath).toBe("/v1/jobs/lucy-image-2");
    });
  });

  describe("Latest aliases", () => {
    it("lucy-latest works as realtime model", () => {
      const model = models.realtime("lucy-latest");
      expect(model.name).toBe("lucy-latest");
      expect(model.urlPath).toBe("/v1/stream");
      expect(model.fps).toEqual({ ideal: 30, max: 30 });
      expect(model.width).toBe(1088);
      expect(model.height).toBe(624);
    });

    it("lucy-vton-latest works as realtime model and resolves server-side to lucy-vton-2", () => {
      const model = models.realtime("lucy-vton-latest");
      expect(model.name).toBe("lucy-vton-latest");
      expect(model.urlPath).toBe("/v1/stream");
      expect(model.fps).toEqual({ ideal: 30, max: 30 });
      expect(model.width).toBe(1088);
      expect(model.height).toBe(624);
    });

    it("lucy-restyle-latest works as realtime model", () => {
      const model = models.realtime("lucy-restyle-latest");
      expect(model.name).toBe("lucy-restyle-latest");
      expect(model.urlPath).toBe("/v1/stream");
      expect(model.fps).toEqual({ ideal: 30, max: 30 });
      expect(model.width).toBe(1280);
      expect(model.height).toBe(704);
    });

    it("lucy-latest works as video model", () => {
      const model = models.video("lucy-latest");
      expect(model.name).toBe("lucy-latest");
      expect(model.urlPath).toBe("/v1/generate/lucy-latest");
      expect(model.queueUrlPath).toBe("/v1/jobs/lucy-latest");
      expect(model.fps).toBe(20);
      expect(model.width).toBe(1088);
      expect(model.height).toBe(624);
    });

    it("lucy-vton-latest works as video model and resolves server-side to lucy-vton-2", () => {
      const model = models.video("lucy-vton-latest");
      expect(model.name).toBe("lucy-vton-latest");
      expect(model.urlPath).toBe("/v1/generate/lucy-vton-latest");
      expect(model.queueUrlPath).toBe("/v1/jobs/lucy-vton-latest");
      expect(model.fps).toBe(20);
      expect(model.width).toBe(1088);
      expect(model.height).toBe(624);
    });

    it("lucy-restyle-latest works as video model", () => {
      const model = models.video("lucy-restyle-latest");
      expect(model.name).toBe("lucy-restyle-latest");
      expect(model.urlPath).toBe("/v1/generate/lucy-restyle-latest");
      expect(model.queueUrlPath).toBe("/v1/jobs/lucy-restyle-latest");
      expect(model.fps).toBe(22);
    });

    it("lucy-clip-latest works as video model", () => {
      const model = models.video("lucy-clip-latest");
      expect(model.name).toBe("lucy-clip-latest");
      expect(model.urlPath).toBe("/v1/generate/lucy-clip-latest");
      expect(model.queueUrlPath).toBe("/v1/jobs/lucy-clip-latest");
      expect(model.fps).toBe(25);
    });

    it("lucy-image-latest works as image model", () => {
      const model = models.image("lucy-image-latest");
      expect(model.name).toBe("lucy-image-latest");
      expect(model.urlPath).toBe("/v1/generate/lucy-image-latest");
      expect(model.queueUrlPath).toBe("/v1/jobs/lucy-image-latest");
    });

    it("lucy-latest is both a realtime and video model", () => {
      expect(isRealtimeModel("lucy-latest")).toBe(true);
      expect(isVideoModel("lucy-latest")).toBe(true);
    });

    it("lucy-vton-latest is both a realtime and video model", () => {
      expect(isRealtimeModel("lucy-vton-latest")).toBe(true);
      expect(isVideoModel("lucy-vton-latest")).toBe(true);
    });

    it("lucy-restyle-latest is both a realtime and video model", () => {
      expect(isRealtimeModel("lucy-restyle-latest")).toBe(true);
      expect(isVideoModel("lucy-restyle-latest")).toBe(true);
    });

    it("does not log deprecation warnings for -latest aliases", () => {
      _resetDeprecationWarnings();
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      models.realtime("lucy-latest");
      models.realtime("lucy-vton-latest");
      models.realtime("lucy-restyle-latest");
      models.video("lucy-latest");
      models.video("lucy-vton-latest");
      models.video("lucy-restyle-latest");
      models.video("lucy-clip-latest");
      models.image("lucy-image-latest");

      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  describe("Dual-surface models", () => {
    it("lucy-2.1 is both a realtime and video model", () => {
      expect(isRealtimeModel("lucy-2.1")).toBe(true);
      expect(isVideoModel("lucy-2.1")).toBe(true);
    });

    it("lucy-2.1-vton is both a realtime and video model", () => {
      expect(isRealtimeModel("lucy-2.1-vton")).toBe(true);
      expect(isVideoModel("lucy-2.1-vton")).toBe(true);
    });

    it("lucy-vton-2 is both a realtime and video model", () => {
      expect(isRealtimeModel("lucy-vton-2")).toBe(true);
      expect(isVideoModel("lucy-vton-2")).toBe(true);
    });

    it("lucy-vton is a deprecated alias for lucy-2.1-vton on both surfaces", () => {
      expect(isRealtimeModel("lucy-vton")).toBe(true);
      expect(isVideoModel("lucy-vton")).toBe(true);
    });

    it("lucy-2.1-vton-2 is a deprecated alias for lucy-vton-2 on both surfaces", () => {
      expect(isRealtimeModel("lucy-2.1-vton-2")).toBe(true);
      expect(isVideoModel("lucy-2.1-vton-2")).toBe(true);
    });

    it("lucy-restyle-2 is both a realtime and video model", () => {
      expect(isRealtimeModel("lucy-restyle-2")).toBe(true);
      expect(isVideoModel("lucy-restyle-2")).toBe(true);
    });
  });

  describe("Deprecated names still work", () => {
    it("mirage_v2 still works as realtime model", () => {
      const model = models.realtime("mirage_v2");
      expect(model.name).toBe("mirage_v2");
    });

    it("lucy-vton still works as realtime and video alias", () => {
      _resetDeprecationWarnings();
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const realtimeModel = models.realtime("lucy-vton");
      const videoModel = models.video("lucy-vton");

      expect(realtimeModel.name).toBe("lucy-vton");
      expect(videoModel.name).toBe("lucy-vton");
      expect(videoModel.urlPath).toBe("/v1/generate/lucy-vton");
      expect(videoModel.queueUrlPath).toBe("/v1/jobs/lucy-vton");
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Model "lucy-vton" is deprecated. Use "lucy-2.1-vton" instead.'),
      );

      warnSpy.mockRestore();
    });

    it("lucy-2.1-vton-2 still works as realtime and video alias", () => {
      _resetDeprecationWarnings();
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const realtimeModel = models.realtime("lucy-2.1-vton-2");
      const videoModel = models.video("lucy-2.1-vton-2");

      expect(realtimeModel.name).toBe("lucy-2.1-vton-2");
      expect(videoModel.name).toBe("lucy-2.1-vton-2");
      expect(videoModel.urlPath).toBe("/v1/generate/lucy-2.1-vton-2");
      expect(videoModel.queueUrlPath).toBe("/v1/jobs/lucy-2.1-vton-2");
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Model "lucy-2.1-vton-2" is deprecated. Use "lucy-vton-2" instead.'),
      );

      warnSpy.mockRestore();
    });

    it("lucy-pro-v2v still works as video model", () => {
      const model = models.video("lucy-pro-v2v");
      expect(model.name).toBe("lucy-pro-v2v");
    });

    it("lucy-pro-i2i still works as image model", () => {
      const model = models.image("lucy-pro-i2i");
      expect(model.name).toBe("lucy-pro-i2i");
    });
  });

  describe("Deprecation warnings", () => {
    it("warns when using deprecated model name", () => {
      _resetDeprecationWarnings();
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      models.video("lucy-pro-v2v");
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Model "lucy-pro-v2v" is deprecated. Use "lucy-clip" instead.'),
      );

      warnSpy.mockClear();
      _resetDeprecationWarnings();
      models.realtime("lucy-vton");
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Model "lucy-vton" is deprecated. Use "lucy-2.1-vton" instead.'),
      );

      warnSpy.mockClear();
      _resetDeprecationWarnings();
      models.video("lucy-2.1-vton-2");
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Model "lucy-2.1-vton-2" is deprecated. Use "lucy-vton-2" instead.'),
      );

      warnSpy.mockRestore();
    });

    it("warns only once per deprecated alias", () => {
      _resetDeprecationWarnings();
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      models.video("lucy-pro-v2v");
      models.video("lucy-pro-v2v");
      expect(warnSpy).toHaveBeenCalledTimes(1);

      warnSpy.mockRestore();
    });
  });
});
