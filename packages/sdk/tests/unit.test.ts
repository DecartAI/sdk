import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDecartClient, isRealtimeModel, isVideoModel, models } from "../src/index.js";
import { _resetDeprecationWarnings } from "../src/shared/model.js";

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

  describe("connect startup conditioning", () => {
    it("sends initial image with the initial prompt after joining the LiveKit room", async () => {
      const { LiveKitConnection } = await import("../src/realtime/livekit-connection.js");
      const sentMessages: Array<{ type: string }> = [];

      class FakeWebSocket {
        static OPEN = 1;
        static CLOSED = 3;
        readyState = FakeWebSocket.OPEN;
        onopen: (() => void) | null = null;
        onmessage: ((event: { data: string }) => void) | null = null;
        onerror: (() => void) | null = null;
        onclose: ((event: { code: number; reason: string }) => void) | null = null;

        constructor(_url: string) {
          setTimeout(() => this.onopen?.(), 0);
        }

        send(data: string): void {
          const msg = JSON.parse(data) as { type: string };
          sentMessages.push(msg);
          if (msg.type === "livekit_join") {
            setTimeout(
              () =>
                this.onmessage?.({
                  data: JSON.stringify({
                    type: "livekit_room_info",
                    livekit_url: "wss://livekit.example.com",
                    token: "token",
                    room_name: "room",
                  }),
                }),
              0,
            );
          }
        }

        close(): void {
          this.readyState = FakeWebSocket.CLOSED;
          this.onclose?.({ code: 1000, reason: "" });
        }
      }

      vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);

      try {
        const connection = new LiveKitConnection({
          initialImage: "base64-image",
          initialPrompt: { text: "Anime", enhance: false },
        });
        const internal = connection as unknown as {
          joinRoom: (info: unknown) => Promise<void>;
        };
        const joinSpy = vi.spyOn(internal, "joinRoom").mockResolvedValue(undefined);
        const imageSpy = vi.spyOn(connection, "setImageBase64").mockResolvedValue(undefined);

        await connection.connect("wss://example.com/v1/stream", {} as MediaStream, 750);

        expect(sentMessages).toContainEqual({ type: "livekit_join" });
        expect(joinSpy).toHaveBeenCalledWith({
          type: "livekit_room_info",
          livekit_url: "wss://livekit.example.com",
          token: "token",
          room_name: "room",
        });
        expect(imageSpy).toHaveBeenCalledWith("base64-image", { prompt: "Anime", enhance: false });
        expect(connection.state).toBe("connected");

        joinSpy.mockRestore();
        imageSpy.mockRestore();
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("surfaces server error control messages", async () => {
      const { LiveKitConnection } = await import("../src/realtime/livekit-connection.js");
      const onError = vi.fn();
      const connection = new LiveKitConnection({ onError });
      const internal = connection as unknown as {
        handleControlMessage: (msg: { type: "error"; error: string }) => void;
      };

      internal.handleControlMessage({ type: "error", error: "server unavailable" });

      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError.mock.calls[0][0]).toMatchObject({
        message: "server unavailable",
        source: "server",
      });
    });

    it("aborts connect when a server error arrives during startup conditioning", async () => {
      const { LiveKitConnection } = await import("../src/realtime/livekit-connection.js");

      class FakeWebSocket {
        static OPEN = 1;
        static CLOSED = 3;
        readyState = FakeWebSocket.OPEN;
        onopen: (() => void) | null = null;
        onmessage: ((event: { data: string }) => void) | null = null;
        onerror: (() => void) | null = null;
        onclose: ((event: { code: number; reason: string }) => void) | null = null;

        constructor(_url: string) {
          setTimeout(() => this.onopen?.(), 0);
        }

        send(data: string): void {
          const msg = JSON.parse(data) as { type: string };
          if (msg.type === "livekit_join") {
            setTimeout(
              () =>
                this.onmessage?.({
                  data: JSON.stringify({
                    type: "livekit_room_info",
                    livekit_url: "wss://livekit.example.com",
                    token: "token",
                    room_name: "room",
                  }),
                }),
              0,
            );
          }
        }

        close(): void {
          this.readyState = FakeWebSocket.CLOSED;
          this.onclose?.({ code: 1000, reason: "" });
        }
      }

      vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);

      try {
        const onError = vi.fn();
        const connection = new LiveKitConnection({ initialImage: "base64-image", onError });
        const internal = connection as unknown as {
          handleControlMessage: (msg: { type: "error"; error: string }) => void;
          joinRoom: (info: unknown) => Promise<void>;
        };
        const joinSpy = vi.spyOn(internal, "joinRoom").mockResolvedValue(undefined);
        const imageSpy = vi.spyOn(connection, "setImageBase64").mockReturnValue(new Promise<void>(() => {}));

        const connectPromise = connection.connect("wss://example.com/v1/stream", {} as MediaStream, 750);
        await vi.waitFor(() => expect(imageSpy).toHaveBeenCalled());

        internal.handleControlMessage({ type: "error", error: "server unavailable" });

        await expect(connectPromise).rejects.toThrow("server unavailable");
        expect(onError).toHaveBeenCalledTimes(1);

        joinSpy.mockRestore();
        imageSpy.mockRestore();
      } finally {
        vi.unstubAllGlobals();
      }
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

    it("submits lucy-2-v2v job with prompt", async () => {
      server.use(
        http.post("http://localhost/v1/jobs/lucy-2-v2v", async ({ request }) => {
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
        model: models.video("lucy-2-v2v"),
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

    it("submits lucy-2-v2v job with empty prompt and reference_image", async () => {
      server.use(
        http.post("http://localhost/v1/jobs/lucy-2-v2v", async ({ request }) => {
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
        model: models.video("lucy-2-v2v"),
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

    it("submits lucy-2-v2v job with reference_image", async () => {
      server.use(
        http.post("http://localhost/v1/jobs/lucy-2-v2v", async ({ request }) => {
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
        model: models.video("lucy-2-v2v"),
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

    it("validates required data input for lucy-2-v2v", async () => {
      await expect(
        decart.queue.submit({
          model: models.video("lucy-2-v2v"),
          prompt: "test",
          // biome-ignore lint/suspicious/noExplicitAny: testing invalid input
        } as any),
      ).rejects.toThrow("Invalid inputs");
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
        constraints: { realtime: { maxSessionDuration: 60 } },
      });

      const body = await lastRequest?.json();
      expect(body).toEqual({
        metadata: { role: "viewer" },
        expiresIn: 300,
        allowedModels: ["lucy-pro-v2v"],
        constraints: { realtime: { maxSessionDuration: 60 } },
      });
    });

    it("returns permissions and constraints from response", async () => {
      server.use(
        http.post("http://localhost/v1/client/tokens", async ({ request }) => {
          lastRequest = request;
          return HttpResponse.json({
            apiKey: "ek_test123",
            expiresAt: "2024-12-15T12:15:00Z",
            permissions: { models: ["lucy-pro-v2v", "lucy-restyle-v2v"] },
            constraints: { realtime: { maxSessionDuration: 120 } },
          });
        }),
      );

      const result = await decart.tokens.create({
        allowedModels: ["lucy-pro-v2v", "lucy-restyle-v2v"],
        constraints: { realtime: { maxSessionDuration: 120 } },
      });

      expect(result.apiKey).toBe("ek_test123");
      expect(result.permissions).toEqual({ models: ["lucy-pro-v2v", "lucy-restyle-v2v"] });
      expect(result.constraints).toEqual({ realtime: { maxSessionDuration: 120 } });
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
      expect(lucyModel.width).toBe(1088);
      expect(lucyModel.height).toBe(624);
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

describe("LiveKitConnection", () => {
  describe("setImageBase64", () => {
    it("rejects immediately when WebSocket is not open", async () => {
      const { LiveKitConnection } = await import("../src/realtime/livekit-connection.js");
      const connection = new LiveKitConnection();

      await expect(connection.setImageBase64("base64data", { timeout: 5000 })).rejects.toThrow("WebSocket is not open");
    });

    it("rejects immediately with default timeout when WebSocket is not open", async () => {
      const { LiveKitConnection } = await import("../src/realtime/livekit-connection.js");
      const connection = new LiveKitConnection();

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
        const { LiveKitConnection } = await import("../src/realtime/livekit-connection.js");
        const connection = new LiveKitConnection();
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
        const { LiveKitConnection } = await import("../src/realtime/livekit-connection.js");
        const connection = new LiveKitConnection();
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

    it("sends set_image with null image_data and null prompt for passthrough", async () => {
      vi.useFakeTimers();
      try {
        const { LiveKitConnection } = await import("../src/realtime/livekit-connection.js");
        const connection = new LiveKitConnection();
        const sendSpy = vi.spyOn(connection, "send").mockReturnValue(true);

        const promise = connection.setImageBase64(null, { prompt: null }).catch(() => {});

        expect(sendSpy).toHaveBeenCalledWith({
          type: "set_image",
          image_data: null,
          prompt: null,
        });

        // Drain the ack timeout so no timers leak
        await vi.advanceTimersByTimeAsync(30001);
        await promise;
        sendSpy.mockRestore();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

describe("Realtime Image Message Types", () => {
  it("SetImageMessage has correct structure", () => {
    const message: import("../src/realtime/types").SetImageMessage = {
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

describe("Subscribe Token", () => {
  it("encodes and decodes a subscribe token round-trip", async () => {
    const { encodeSubscribeToken, decodeSubscribeToken } = await import("../src/realtime/subscribe-client.js");
    const token = encodeSubscribeToken("sess-123", "10.0.0.1", 8080);
    const decoded = decodeSubscribeToken(token);

    expect(decoded.sid).toBe("sess-123");
    expect(decoded.ip).toBe("10.0.0.1");
    expect(decoded.port).toBe(8080);
  });

  it("throws on invalid base64 token", async () => {
    const { decodeSubscribeToken } = await import("../src/realtime/subscribe-client.js");
    expect(() => decodeSubscribeToken("not-valid-base64!!!")).toThrow("Invalid subscribe token");
  });

  it("throws on valid base64 but invalid payload", async () => {
    const { decodeSubscribeToken } = await import("../src/realtime/subscribe-client.js");
    const token = btoa(JSON.stringify({ sid: "s" }));
    expect(() => decodeSubscribeToken(token)).toThrow("Invalid subscribe token");
  });
});

describe("Subscribe Client", () => {
  it("subscribe mode allows reconnect with null localStream", async () => {
    const { LiveKitManager } = await import("../src/realtime/livekit-manager.js");

    const manager = new LiveKitManager({
      url: "wss://example.com",
      onRemoteStream: vi.fn(),
      onError: vi.fn(),
    });

    const internal = manager as unknown as {
      handleConnectionStateChange: (state: import("../src/realtime/types").ConnectionState) => void;
      reconnect: () => Promise<void>;
      subscribeMode: boolean;
      hasConnected: boolean;
    };

    internal.subscribeMode = true;
    internal.hasConnected = true;

    const reconnectSpy = vi.spyOn(internal, "reconnect").mockResolvedValue(undefined);
    try {
      internal.handleConnectionStateChange("disconnected");
      expect(reconnectSpy).toHaveBeenCalledTimes(1);
    } finally {
      reconnectSpy.mockRestore();
    }
  });

  it("publishes video with fixed h264 codec and 2.5Mbps bitrate", async () => {
    const { LiveKitConnection } = await import("../src/realtime/livekit-connection.js");
    const publishTrack = vi.fn().mockResolvedValue({ trackSid: "video-sid", mimeType: "video/H264" });
    const videoTrack = {
      kind: "video",
      label: "camera",
      getSettings: () => ({ width: 1280, height: 720, frameRate: 22 }),
    } as unknown as MediaStreamTrack;
    const stream = { getTracks: () => [videoTrack] } as unknown as MediaStream;
    const connection = new LiveKitConnection();
    const internal = connection as unknown as {
      room: unknown;
      publishLocalTracks: (stream: MediaStream) => Promise<void>;
    };
    internal.room = { localParticipant: { publishTrack } };

    await internal.publishLocalTracks(stream);

    expect(publishTrack).toHaveBeenCalledTimes(1);
    const options = publishTrack.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(options).toMatchObject({
      videoCodec: "h264",
      videoEncoding: { maxBitrate: 2_500_000 },
    });
    expect(options).not.toHaveProperty("simulcast");
    expect(options).not.toHaveProperty("scalabilityMode");
    expect(options).not.toHaveProperty("degradationPreference");
    expect(options.videoEncoding).not.toHaveProperty("maxFramerate");
  });

  it("session_id message populates subscribeToken on producer client", async () => {
    const { createRealTimeClient } = await import("../src/realtime/client.js");
    const { LiveKitManager } = await import("../src/realtime/livekit-manager.js");
    const { decodeSubscribeToken } = await import("../src/realtime/subscribe-client.js");

    const sessionIdListeners = new Set<(msg: import("../src/realtime/types").SessionIdMessage) => void>();
    const websocketEmitter = {
      on: (event: string, listener: (msg: import("../src/realtime/types").SessionIdMessage) => void) => {
        if (event === "sessionId") sessionIdListeners.add(listener);
      },
      off: (event: string, listener: (msg: import("../src/realtime/types").SessionIdMessage) => void) => {
        if (event === "sessionId") sessionIdListeners.delete(listener);
      },
    };

    const connectSpy = vi.spyOn(LiveKitManager.prototype, "connect").mockImplementation(async function () {
      const mgr = this as unknown as {
        config: { onConnectionStateChange?: (state: import("../src/realtime/types").ConnectionState) => void };
        managerState: import("../src/realtime/types").ConnectionState;
      };
      mgr.managerState = "connected";
      mgr.config.onConnectionStateChange?.("connected");
      return true;
    });
    const stateSpy = vi.spyOn(LiveKitManager.prototype, "getConnectionState").mockReturnValue("connected");
    const emitterSpy = vi
      .spyOn(LiveKitManager.prototype, "getWebsocketMessageEmitter")
      .mockReturnValue(websocketEmitter as never);
    const sendSpy = vi.spyOn(LiveKitManager.prototype, "sendMessage").mockReturnValue(true);
    const cleanupSpy = vi.spyOn(LiveKitManager.prototype, "cleanup").mockImplementation(() => {});

    try {
      const realtime = createRealTimeClient({ baseUrl: "wss://api3.decart.ai", apiKey: "test-key" });
      const client = await realtime.connect({} as MediaStream, {
        model: models.realtime("mirage_v2"),
        onRemoteStream: vi.fn(),
      });

      expect(client.subscribeToken).toBeNull();

      for (const listener of sessionIdListeners) {
        listener({
          type: "session_id",
          session_id: "sess-abc",
          server_ip: "10.0.0.5",
          server_port: 9090,
        });
      }

      const token = client.subscribeToken;
      expect(token).not.toBeNull();
      // biome-ignore lint/style/noNonNullAssertion: guarded by assertion above
      const decoded = decodeSubscribeToken(token!);
      expect(decoded.sid).toBe("sess-abc");
      expect(decoded.ip).toBe("10.0.0.5");
      expect(decoded.port).toBe(9090);
    } finally {
      connectSpy.mockRestore();
      stateSpy.mockRestore();
      emitterSpy.mockRestore();
      sendSpy.mockRestore();
      cleanupSpy.mockRestore();
    }
  });

  it("exposes status and queue_position websocket messages as realtime client events", async () => {
    const { createRealTimeClient } = await import("../src/realtime/client.js");
    const { LiveKitManager } = await import("../src/realtime/livekit-manager.js");

    type QueueMsg =
      | { type: "status"; status: string }
      | { type: "queue_position"; position: number; queue_size: number };
    const statusListeners = new Set<(msg: QueueMsg) => void>();
    const queuePositionListeners = new Set<(msg: QueueMsg) => void>();
    const websocketEmitter = {
      on: (event: string, listener: (msg: QueueMsg) => void) => {
        if (event === "status") statusListeners.add(listener);
        if (event === "queuePosition") queuePositionListeners.add(listener);
      },
      off: (event: string, listener: (msg: QueueMsg) => void) => {
        if (event === "status") statusListeners.delete(listener);
        if (event === "queuePosition") queuePositionListeners.delete(listener);
      },
    };

    const connectSpy = vi.spyOn(LiveKitManager.prototype, "connect").mockImplementation(async function () {
      const mgr = this as unknown as {
        config: { onConnectionStateChange?: (state: import("../src/realtime/types").ConnectionState) => void };
        managerState: import("../src/realtime/types").ConnectionState;
      };
      mgr.managerState = "connected";
      mgr.config.onConnectionStateChange?.("connected");
      return true;
    });
    const stateSpy = vi.spyOn(LiveKitManager.prototype, "getConnectionState").mockReturnValue("connected");
    const emitterSpy = vi
      .spyOn(LiveKitManager.prototype, "getWebsocketMessageEmitter")
      .mockReturnValue(websocketEmitter as never);
    const cleanupSpy = vi.spyOn(LiveKitManager.prototype, "cleanup").mockImplementation(() => {});

    try {
      const realtime = createRealTimeClient({ baseUrl: "wss://api3.decart.ai", apiKey: "test-key" });
      const client = await realtime.connect({} as MediaStream, {
        model: models.realtime("mirage_v2"),
        onRemoteStream: vi.fn(),
      });

      const statusEvents: string[] = [];
      const queueEvents: Array<{ position: number; queueSize: number }> = [];

      client.on("status", (status) => statusEvents.push(status));
      client.on("queuePosition", (data) => queueEvents.push(data));

      for (const listener of statusListeners) {
        listener({ type: "status", status: "queued" });
      }
      for (const listener of queuePositionListeners) {
        listener({ type: "queue_position", position: 2, queue_size: 11 });
      }

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(statusEvents).toEqual(["queued"]);
      expect(queueEvents).toEqual([{ position: 2, queueSize: 11 }]);
    } finally {
      connectSpy.mockRestore();
      stateSpy.mockRestore();
      emitterSpy.mockRestore();
      cleanupSpy.mockRestore();
    }
  });

  it("calls onStatus and onQueuePosition callbacks when websocket updates arrive", async () => {
    const { createRealTimeClient } = await import("../src/realtime/client.js");
    const { LiveKitManager } = await import("../src/realtime/livekit-manager.js");

    type QueueMsg =
      | { type: "status"; status: string }
      | { type: "queue_position"; position: number; queue_size: number };
    const statusListeners = new Set<(msg: QueueMsg) => void>();
    const queuePositionListeners = new Set<(msg: QueueMsg) => void>();
    const websocketEmitter = {
      on: (event: string, listener: (msg: QueueMsg) => void) => {
        if (event === "status") statusListeners.add(listener);
        if (event === "queuePosition") queuePositionListeners.add(listener);
      },
      off: (event: string, listener: (msg: QueueMsg) => void) => {
        if (event === "status") statusListeners.delete(listener);
        if (event === "queuePosition") queuePositionListeners.delete(listener);
      },
    };

    const connectSpy = vi.spyOn(LiveKitManager.prototype, "connect").mockImplementation(async function () {
      const mgr = this as unknown as {
        config: { onConnectionStateChange?: (state: import("../src/realtime/types").ConnectionState) => void };
        managerState: import("../src/realtime/types").ConnectionState;
      };
      mgr.managerState = "connected";
      mgr.config.onConnectionStateChange?.("connected");
      return true;
    });
    const stateSpy = vi.spyOn(LiveKitManager.prototype, "getConnectionState").mockReturnValue("connected");
    const emitterSpy = vi
      .spyOn(LiveKitManager.prototype, "getWebsocketMessageEmitter")
      .mockReturnValue(websocketEmitter as never);
    const cleanupSpy = vi.spyOn(LiveKitManager.prototype, "cleanup").mockImplementation(() => {});

    try {
      const onStatus = vi.fn();
      const onQueuePosition = vi.fn();

      const realtime = createRealTimeClient({ baseUrl: "wss://api3.decart.ai", apiKey: "test-key" });
      await realtime.connect({} as MediaStream, {
        model: models.realtime("mirage_v2"),
        onRemoteStream: vi.fn(),
        onStatus,
        onQueuePosition,
      });

      for (const listener of statusListeners) {
        listener({ type: "status", status: "initializing" });
      }
      for (const listener of queuePositionListeners) {
        listener({ type: "queue_position", position: 4, queue_size: 19 });
      }

      expect(onStatus).toHaveBeenCalledWith("initializing");
      expect(onQueuePosition).toHaveBeenCalledWith({ position: 4, queueSize: 19 });
    } finally {
      connectSpy.mockRestore();
      stateSpy.mockRestore();
      emitterSpy.mockRestore();
      cleanupSpy.mockRestore();
    }
  });

  it("requestRoomInfo waits indefinitely once a queue update has arrived", async () => {
    const { LiveKitConnection } = await import("../src/realtime/livekit-connection.js");

    vi.useFakeTimers();
    try {
      const connection = new LiveKitConnection();
      const internal = connection as unknown as {
        send: (msg: unknown) => boolean;
        requestRoomInfo: () => Promise<unknown>;
        handleControlMessage: (msg: unknown) => void;
      };
      // Stub send so requestRoomInfo doesn't try to use a real WebSocket.
      internal.send = () => true;

      const settled = vi.fn();
      const promise = internal.requestRoomInfo().then(
        (v) => settled("resolved" + JSON.stringify(v)),
        (e) => settled("rejected:" + (e as Error).message),
      );

      // First queue_position arrives within the initial 15s window —
      // this should disable the deadline entirely.
      await vi.advanceTimersByTimeAsync(5_000);
      internal.handleControlMessage({ type: "queue_position", position: 5, queue_size: 10 });

      // Sit silent for an hour; the deadline must NOT fire.
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(settled).not.toHaveBeenCalled();

      // Resolve cleanly with the real room info.
      internal.handleControlMessage({
        type: "livekit_room_info",
        livekit_url: "wss://livekit.example.com",
        token: "tk",
        room_name: "room",
      });
      await promise;
      expect(settled).toHaveBeenCalledWith(expect.stringMatching(/^resolved/));
    } finally {
      vi.useRealTimers();
    }
  });

  it("requestRoomInfo times out if the bouncer is silent within the initial window", async () => {
    const { LiveKitConnection } = await import("../src/realtime/livekit-connection.js");

    vi.useFakeTimers();
    try {
      const connection = new LiveKitConnection();
      const internal = connection as unknown as {
        send: (msg: unknown) => boolean;
        requestRoomInfo: () => Promise<unknown>;
        handleControlMessage: (msg: unknown) => void;
      };
      internal.send = () => true;

      // Attach the rejection handler eagerly so the test's microtask
      // queue doesn't see an unhandled rejection when the timer fires
      // during `advanceTimersByTimeAsync`.
      const promise = internal.requestRoomInfo();
      const settled = promise.catch((e: Error) => e);
      // No queue/status message ever arrives. Initial 15s window expires.
      await vi.advanceTimersByTimeAsync(15_001);

      const error = await settled;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/livekit_room_info timeout/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("buffers pre-session telemetry diagnostics and flushes them after session_id", async () => {
    const { createRealTimeClient } = await import("../src/realtime/client.js");
    const { LiveKitManager } = await import("../src/realtime/livekit-manager.js");

    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const sessionIdListeners = new Set<(msg: import("../src/realtime/types").SessionIdMessage) => void>();
    const websocketEmitter = {
      on: (event: string, listener: (msg: import("../src/realtime/types").SessionIdMessage) => void) => {
        if (event === "sessionId") sessionIdListeners.add(listener);
      },
      off: (event: string, listener: (msg: import("../src/realtime/types").SessionIdMessage) => void) => {
        if (event === "sessionId") sessionIdListeners.delete(listener);
      },
    };

    const connectSpy = vi.spyOn(LiveKitManager.prototype, "connect").mockImplementation(async function () {
      const mgr = this as unknown as {
        config: {
          onConnectionStateChange?: (state: import("../src/realtime/types").ConnectionState) => void;
          onDiagnostic?: (name: string, data: unknown) => void;
        };
        managerState: import("../src/realtime/types").ConnectionState;
      };

      mgr.config.onDiagnostic?.("phaseTiming", {
        phase: "websocket",
        durationMs: 12,
        success: true,
      });

      mgr.managerState = "connected";
      mgr.config.onConnectionStateChange?.("connected");
      return true;
    });
    const stateSpy = vi.spyOn(LiveKitManager.prototype, "getConnectionState").mockReturnValue("connected");
    const emitterSpy = vi
      .spyOn(LiveKitManager.prototype, "getWebsocketMessageEmitter")
      .mockReturnValue(websocketEmitter as never);
    const cleanupSpy = vi.spyOn(LiveKitManager.prototype, "cleanup").mockImplementation(() => {});

    try {
      const realtime = createRealTimeClient({
        baseUrl: "wss://api3.decart.ai",
        apiKey: "test-key",
        logger: { debug() {}, info() {}, warn() {}, error() {} },
        telemetryEnabled: true,
      });
      const client = await realtime.connect({} as MediaStream, {
        model: models.realtime("mirage_v2"),
        onRemoteStream: vi.fn(),
      });

      expect(fetchMock).not.toHaveBeenCalled();

      for (const listener of sessionIdListeners) {
        listener({
          type: "session_id",
          session_id: "sess-telemetry",
          server_ip: "10.0.0.5",
          server_port: 9090,
        });
      }

      client.disconnect();

      await vi.waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });

      const [, options] = fetchMock.mock.calls[0];
      const body = JSON.parse(options.body);
      expect(body.diagnostics).toHaveLength(1);
      expect(body.diagnostics[0].name).toBe("phaseTiming");
      expect(body.diagnostics[0].data.phase).toBe("websocket");
    } finally {
      connectSpy.mockRestore();
      stateSpy.mockRestore();
      emitterSpy.mockRestore();
      cleanupSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("stops previous telemetry reporter when session_id changes", async () => {
    const { createRealTimeClient } = await import("../src/realtime/client.js");
    const { LiveKitManager } = await import("../src/realtime/livekit-manager.js");

    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");

    const sessionIdListeners = new Set<(msg: import("../src/realtime/types").SessionIdMessage) => void>();
    const websocketEmitter = {
      on: (event: string, listener: (msg: import("../src/realtime/types").SessionIdMessage) => void) => {
        if (event === "sessionId") sessionIdListeners.add(listener);
      },
      off: (event: string, listener: (msg: import("../src/realtime/types").SessionIdMessage) => void) => {
        if (event === "sessionId") sessionIdListeners.delete(listener);
      },
    };

    const connectSpy = vi.spyOn(LiveKitManager.prototype, "connect").mockImplementation(async function () {
      const mgr = this as unknown as {
        config: { onConnectionStateChange?: (state: import("../src/realtime/types").ConnectionState) => void };
        managerState: import("../src/realtime/types").ConnectionState;
      };
      mgr.managerState = "connected";
      mgr.config.onConnectionStateChange?.("connected");
      return true;
    });
    const stateSpy = vi.spyOn(LiveKitManager.prototype, "getConnectionState").mockReturnValue("connected");
    const emitterSpy = vi
      .spyOn(LiveKitManager.prototype, "getWebsocketMessageEmitter")
      .mockReturnValue(websocketEmitter as never);
    const cleanupSpy = vi.spyOn(LiveKitManager.prototype, "cleanup").mockImplementation(() => {});

    try {
      const realtime = createRealTimeClient({
        baseUrl: "wss://api3.decart.ai",
        apiKey: "test-key",
        logger: { debug() {}, info() {}, warn() {}, error() {} },
        telemetryEnabled: true,
      });
      const client = await realtime.connect({} as MediaStream, {
        model: models.realtime("mirage_v2"),
        onRemoteStream: vi.fn(),
      });

      for (const listener of sessionIdListeners) {
        listener({
          type: "session_id",
          session_id: "sess-1",
          server_ip: "10.0.0.5",
          server_port: 9090,
        });
      }
      for (const listener of sessionIdListeners) {
        listener({
          type: "session_id",
          session_id: "sess-2",
          server_ip: "10.0.0.6",
          server_port: 9091,
        });
      }

      client.disconnect();

      expect(setIntervalSpy).toHaveBeenCalledTimes(2);
      expect(clearIntervalSpy).toHaveBeenCalledTimes(2);
    } finally {
      connectSpy.mockRestore();
      stateSpy.mockRestore();
      emitterSpy.mockRestore();
      cleanupSpy.mockRestore();
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("restarts stats collection when stats source changes after reconnect (LiveKit)", async () => {
    const { createRealTimeClient } = await import("../src/realtime/client.js");
    const { LiveKitManager } = await import("../src/realtime/livekit-manager.js");
    const { WebRTCStatsCollector } = await import("../src/realtime/webrtc-stats.js");

    const firstStatsSource = { getStats: vi.fn() };
    const secondStatsSource = { getStats: vi.fn() };
    let currentStatsSource: typeof firstStatsSource = firstStatsSource;
    let onConnectionStateChange: ((state: import("../src/realtime/types").ConnectionState) => void) | undefined;

    const startSpy = vi.spyOn(WebRTCStatsCollector.prototype, "start").mockImplementation(() => {});
    const stopSpy = vi.spyOn(WebRTCStatsCollector.prototype, "stop").mockImplementation(() => {});

    const connectSpy = vi.spyOn(LiveKitManager.prototype, "connect").mockImplementation(async function () {
      const mgr = this as unknown as {
        config: { onConnectionStateChange?: (state: import("../src/realtime/types").ConnectionState) => void };
        managerState: import("../src/realtime/types").ConnectionState;
      };
      onConnectionStateChange = mgr.config.onConnectionStateChange;
      mgr.managerState = "connected";
      mgr.config.onConnectionStateChange?.("connected");
      return true;
    });
    const stateSpy = vi.spyOn(LiveKitManager.prototype, "getConnectionState").mockReturnValue("connected");
    const statsProviderSpy = vi
      .spyOn(LiveKitManager.prototype, "getStatsProvider")
      .mockImplementation(() => currentStatsSource);
    const cleanupSpy = vi.spyOn(LiveKitManager.prototype, "cleanup").mockImplementation(() => {});

    try {
      const realtime = createRealTimeClient({
        baseUrl: "wss://api3.decart.ai",
        apiKey: "test-key",
        logger: { debug() {}, info() {}, warn() {}, error() {} },
        telemetryEnabled: true,
      });
      const client = await realtime.connect({} as MediaStream, {
        model: models.realtime("mirage_v2"),
        onRemoteStream: vi.fn(),
      });

      expect(startSpy).toHaveBeenCalledTimes(1);
      expect(startSpy.mock.calls[0][0]).toBe(firstStatsSource);

      currentStatsSource = secondStatsSource;
      onConnectionStateChange?.("connected");

      expect(startSpy).toHaveBeenCalledTimes(2);
      expect(startSpy.mock.calls[1][0]).toBe(secondStatsSource);

      client.disconnect();
      expect(stopSpy).toHaveBeenCalled();
    } finally {
      startSpy.mockRestore();
      stopSpy.mockRestore();
      connectSpy.mockRestore();
      stateSpy.mockRestore();
      statsProviderSpy.mockRestore();
      cleanupSpy.mockRestore();
    }
  });

  it("subscribe client buffers events until returned", async () => {
    const { encodeSubscribeToken } = await import("../src/realtime/subscribe-client.js");
    const { createRealTimeClient } = await import("../src/realtime/client.js");
    const { LiveKitManager } = await import("../src/realtime/livekit-manager.js");

    const connectSpy = vi.spyOn(LiveKitManager.prototype, "connect").mockImplementation(async function () {
      const mgr = this as unknown as {
        config: { onConnectionStateChange?: (state: import("../src/realtime/types").ConnectionState) => void };
        managerState: import("../src/realtime/types").ConnectionState;
      };
      mgr.managerState = "connected";
      mgr.config.onConnectionStateChange?.("connected");
      return true;
    });
    const stateSpy = vi.spyOn(LiveKitManager.prototype, "getConnectionState").mockReturnValue("connected");
    const cleanupSpy = vi.spyOn(LiveKitManager.prototype, "cleanup").mockImplementation(() => {});

    try {
      const token = encodeSubscribeToken("sess-123", "10.0.0.1", 8080);
      const realtime = createRealTimeClient({ baseUrl: "wss://api3.decart.ai", apiKey: "sub-key" });
      const client = await realtime.subscribe({
        token,
        onRemoteStream: vi.fn(),
      });

      const states: import("../src/realtime/types").ConnectionState[] = [];
      client.on("connectionChange", (state) => states.push(state));

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(states).toEqual(["connected"]);

      client.disconnect();
    } finally {
      connectSpy.mockRestore();
      stateSpy.mockRestore();
      cleanupSpy.mockRestore();
    }
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

describe("WebRTC Error Classification", () => {
  it("classifies websocket errors", async () => {
    const { classifyWebrtcError, ERROR_CODES } = await import("../src/utils/errors.js");
    const result = classifyWebrtcError(new Error("WebSocket connection closed"));
    expect(result.code).toBe(ERROR_CODES.WEBRTC_WEBSOCKET_ERROR);
  });

  it("classifies ICE errors", async () => {
    const { classifyWebrtcError, ERROR_CODES } = await import("../src/utils/errors.js");
    const result = classifyWebrtcError(new Error("ICE connection failed"));
    expect(result.code).toBe(ERROR_CODES.WEBRTC_ICE_ERROR);
  });

  it("classifies timeout errors", async () => {
    const { classifyWebrtcError, ERROR_CODES } = await import("../src/utils/errors.js");
    const result = classifyWebrtcError(new Error("Connection timed out"));
    expect(result.code).toBe(ERROR_CODES.WEBRTC_TIMEOUT_ERROR);
    expect(result.message).toBe("connection timed out");
    expect(result.data).toEqual({ phase: "connection" });
  });

  it("classifies server-originated errors", async () => {
    const { classifyWebrtcError, ERROR_CODES } = await import("../src/utils/errors.js");
    const error = new Error("Insufficient credits") as Error & { source?: string };
    error.source = "server";
    const result = classifyWebrtcError(error);
    expect(result.code).toBe(ERROR_CODES.WEBRTC_SERVER_ERROR);
    expect(result.message).toBe("Insufficient credits");
  });

  it("classifies unknown errors as signaling errors", async () => {
    const { classifyWebrtcError, ERROR_CODES } = await import("../src/utils/errors.js");
    const result = classifyWebrtcError(new Error("room join failed"));
    expect(result.code).toBe(ERROR_CODES.WEBRTC_SIGNALING_ERROR);
  });

  it("createWebrtcTimeoutError includes phase and timeout data", async () => {
    const { createWebrtcTimeoutError, ERROR_CODES } = await import("../src/utils/errors.js");
    const result = createWebrtcTimeoutError("webrtc-handshake", 30000);
    expect(result.code).toBe(ERROR_CODES.WEBRTC_TIMEOUT_ERROR);
    expect(result.message).toBe("webrtc-handshake timed out after 30000ms");
    expect(result.data).toEqual({ phase: "webrtc-handshake", timeoutMs: 30000 });
  });

  it("createWebrtcServerError preserves the message", async () => {
    const { createWebrtcServerError, ERROR_CODES } = await import("../src/utils/errors.js");
    const result = createWebrtcServerError("Server overloaded");
    expect(result.code).toBe(ERROR_CODES.WEBRTC_SERVER_ERROR);
    expect(result.message).toBe("Server overloaded");
  });

  it("factory functions preserve the cause error", async () => {
    const { createWebrtcWebsocketError } = await import("../src/utils/errors.js");
    const cause = new Error("original");
    const result = createWebrtcWebsocketError(cause);
    expect(result.cause).toBe(cause);
  });
});

describe("WebRTCStatsCollector", () => {
  it("starts and stops polling", async () => {
    const { WebRTCStatsCollector } = await import("../src/realtime/webrtc-stats.js");
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
    const { WebRTCStatsCollector } = await import("../src/realtime/webrtc-stats.js");

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

      const receivedStats: Array<import("../src/realtime/webrtc-stats.js").WebRTCStats> = [];
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
    const { WebRTCStatsCollector } = await import("../src/realtime/webrtc-stats.js");

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

      const receivedStats: Array<import("../src/realtime/webrtc-stats.js").WebRTCStats> = [];
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
    const { WebRTCStatsCollector } = await import("../src/realtime/webrtc-stats.js");

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

      const receivedStats: Array<import("../src/realtime/webrtc-stats.js").WebRTCStats> = [];
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
    const { WebRTCStatsCollector } = await import("../src/realtime/webrtc-stats.js");

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
    const { WebRTCStatsCollector } = await import("../src/realtime/webrtc-stats.js");

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
    const { TelemetryReporter } = await import("../src/realtime/telemetry-reporter.js");

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
        name: "phaseTiming",
        data: { phase: "total", durationMs: 500, success: true },
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
      expect(options.keepalive).toBe(false);

      const body = JSON.parse(options.body);
      expect(body.sessionId).toBe("sess-1");
      expect(body.stats).toHaveLength(1);
      expect(body.diagnostics).toHaveLength(1);
      expect(body.diagnostics[0].name).toBe("phaseTiming");

      reporter.stop();
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("does not send empty reports", async () => {
    const { TelemetryReporter } = await import("../src/realtime/telemetry-reporter.js");

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
    const { TelemetryReporter } = await import("../src/realtime/telemetry-reporter.js");

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
      const [, options] = fetchMock.mock.calls[0];
      expect(options.keepalive).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("silently handles fetch failures", async () => {
    const { TelemetryReporter } = await import("../src/realtime/telemetry-reporter.js");

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
    const { TelemetryReporter } = await import("../src/realtime/telemetry-reporter.js");

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
    const { TelemetryReporter } = await import("../src/realtime/telemetry-reporter.js");

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
    const { TelemetryReporter } = await import("../src/realtime/telemetry-reporter.js");

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

  it("warns on non-2xx response status", async () => {
    const { TelemetryReporter } = await import("../src/realtime/telemetry-reporter.js");

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

      // Wait for the .then() handler to execute
      await vi.waitFor(() => {
        expect(warnMock).toHaveBeenCalledTimes(1);
      });

      expect(warnMock).toHaveBeenCalledWith("Telemetry report rejected", {
        status: 500,
        statusText: "Internal Server Error",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("includes model in report body and tags when provided", async () => {
    const { TelemetryReporter } = await import("../src/realtime/telemetry-reporter.js");

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
    const { TelemetryReporter } = await import("../src/realtime/telemetry-reporter.js");

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

describe("WebSockets Connection", () => {
  it("treats generating as an established connection for reconnect decisions", async () => {
    const { LiveKitManager } = await import("../src/realtime/livekit-manager.js");
    const manager = new LiveKitManager({
      url: "wss://example.com",
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
    const { LiveKitManager } = await import("../src/realtime/livekit-manager.js");

    const promptAckListeners = new Set<(msg: import("../src/realtime/types").PromptAckMessage) => void>();
    const websocketEmitter = {
      on: (event: string, listener: (msg: import("../src/realtime/types").PromptAckMessage) => void) => {
        if (event === "promptAck") promptAckListeners.add(listener);
      },
      off: (event: string, listener: (msg: import("../src/realtime/types").PromptAckMessage) => void) => {
        if (event === "promptAck") promptAckListeners.delete(listener);
      },
    };

    const connectSpy = vi.spyOn(LiveKitManager.prototype, "connect").mockImplementation(async function () {
      const manager = this as unknown as {
        config: {
          onConnectionStateChange?: (state: import("../src/realtime/types").ConnectionState) => void;
          initialPrompt?: { text: string; enhance?: boolean };
        };
        managerState: import("../src/realtime/types").ConnectionState;
      };
      manager.managerState = "connected";
      manager.config.onConnectionStateChange?.("connected");

      // Simulate initial prompt sent via WebSocket during connection setup
      if (manager.config.initialPrompt) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        manager.managerState = "generating";
        manager.config.onConnectionStateChange?.("generating");
      }

      return true;
    });
    const stateSpy = vi.spyOn(LiveKitManager.prototype, "getConnectionState").mockImplementation(function () {
      const manager = this as unknown as { managerState: import("../src/realtime/types").ConnectionState };
      return manager.managerState ?? "connected";
    });
    const emitterSpy = vi
      .spyOn(LiveKitManager.prototype, "getWebsocketMessageEmitter")
      .mockReturnValue(websocketEmitter as never);
    const sendSpy = vi.spyOn(LiveKitManager.prototype, "sendMessage").mockImplementation(function (message) {
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
    const cleanupSpy = vi.spyOn(LiveKitManager.prototype, "cleanup").mockImplementation(() => {});

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

describe("NullTelemetryReporter", () => {
  it("all methods are no-ops", async () => {
    const { NullTelemetryReporter } = await import("../src/realtime/telemetry-reporter.js");
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
    reporter.addDiagnostic({ name: "phaseTiming", data: {}, timestamp: 1000 });
    reporter.flush();
    reporter.stop();
  });

  it("implements ITelemetryReporter interface", async () => {
    const { NullTelemetryReporter } = await import("../src/realtime/telemetry-reporter.js");
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
    const { WebRTCStatsCollector } = await import("../src/realtime/webrtc-stats.js");

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

      const receivedStats: Array<import("../src/realtime/webrtc-stats.js").WebRTCStats> = [];
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
    const { WebRTCStatsCollector } = await import("../src/realtime/webrtc-stats.js");

    vi.useFakeTimers();
    try {
      const collector = new WebRTCStatsCollector({ intervalMs: 1000 });

      const mockPC = {
        getStats: vi.fn().mockResolvedValue(new Map()),
      } as unknown as RTCPeerConnection;

      const receivedStats: Array<import("../src/realtime/webrtc-stats.js").WebRTCStats> = [];
      collector.start(mockPC, (stats) => receivedStats.push(stats));

      await vi.advanceTimersByTimeAsync(1000);

      expect(receivedStats[0].outboundVideo).toBeNull();

      collector.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("computes outbound video bitrate from bytesSent delta", async () => {
    const { WebRTCStatsCollector } = await import("../src/realtime/webrtc-stats.js");

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

      const receivedStats: Array<import("../src/realtime/webrtc-stats.js").WebRTCStats> = [];
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
    const { WebRTCStatsCollector } = await import("../src/realtime/webrtc-stats.js");

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

      const receivedStats: Array<import("../src/realtime/webrtc-stats.js").WebRTCStats> = [];
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
    const { WebRTCStatsCollector } = await import("../src/realtime/webrtc-stats.js");

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

      const receivedStats: Array<import("../src/realtime/webrtc-stats.js").WebRTCStats> = [];
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
    const { WebRTCStatsCollector } = await import("../src/realtime/webrtc-stats.js");

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

      const receivedStats: Array<import("../src/realtime/webrtc-stats.js").WebRTCStats> = [];
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
    const event: import("../src/realtime/diagnostics.js").DiagnosticEvent = {
      name: "videoStall",
      data: { stalled: true, durationMs: 0 },
    };
    expect(event.name).toBe("videoStall");
    expect(event.data.stalled).toBe(true);
    expect(event.data.durationMs).toBe(0);
  });

  it("videoStall recovery includes duration", () => {
    const event: import("../src/realtime/diagnostics.js").DiagnosticEvent = {
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
  describe("Realtime canonical models", () => {
    it("lucy canonical name works", () => {
      const model = models.realtime("lucy");
      expect(model.name).toBe("lucy");
      expect(model.urlPath).toBe("/v1/stream");
      expect(model.fps).toBe(25);
      expect(model.width).toBe(1280);
      expect(model.height).toBe(704);
    });

    it("lucy-2 canonical name works", () => {
      const model = models.realtime("lucy-2");
      expect(model.name).toBe("lucy-2");
      expect(model.urlPath).toBe("/v1/stream");
      expect(model.fps).toBe(20);
      expect(model.width).toBe(1088);
      expect(model.height).toBe(624);
    });

    it("lucy-2.1 canonical name works", () => {
      const model = models.realtime("lucy-2.1");
      expect(model.name).toBe("lucy-2.1");
      expect(model.urlPath).toBe("/v1/stream");
      expect(model.fps).toBe(20);
      expect(model.width).toBe(1088);
      expect(model.height).toBe(624);
    });

    it("lucy-2.1-vton canonical name works", () => {
      const model = models.realtime("lucy-2.1-vton");
      expect(model.name).toBe("lucy-2.1-vton");
      expect(model.urlPath).toBe("/v1/stream");
      expect(model.fps).toBe(20);
      expect(model.width).toBe(1088);
      expect(model.height).toBe(624);
    });

    it("lucy-restyle canonical name works", () => {
      const model = models.realtime("lucy-restyle");
      expect(model.name).toBe("lucy-restyle");
      expect(model.fps).toBe(25);
    });

    it("lucy-restyle-2 canonical name works", () => {
      const model = models.realtime("lucy-restyle-2");
      expect(model.name).toBe("lucy-restyle-2");
      expect(model.fps).toBe(22);
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

    it("lucy-2 as video model works", () => {
      const model = models.video("lucy-2");
      expect(model.name).toBe("lucy-2");
      expect(model.urlPath).toBe("/v1/generate/lucy-2");
      expect(model.queueUrlPath).toBe("/v1/jobs/lucy-2");
      expect(model.fps).toBe(20);
    });

    it("lucy-2.1 as video model works", () => {
      const model = models.video("lucy-2.1");
      expect(model.name).toBe("lucy-2.1");
      expect(model.urlPath).toBe("/v1/generate/lucy-2.1");
      expect(model.queueUrlPath).toBe("/v1/jobs/lucy-2.1");
    });

    it("lucy-2.1-vton as video model works", () => {
      const model = models.video("lucy-2.1-vton");
      expect(model.name).toBe("lucy-2.1-vton");
      expect(model.urlPath).toBe("/v1/generate/lucy-2.1-vton");
      expect(model.queueUrlPath).toBe("/v1/jobs/lucy-2.1-vton");
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
      expect(model.fps).toBe(20);
      expect(model.width).toBe(1088);
      expect(model.height).toBe(624);
    });

    it("lucy-vton-latest works as realtime model", () => {
      const model = models.realtime("lucy-vton-latest");
      expect(model.name).toBe("lucy-vton-latest");
      expect(model.urlPath).toBe("/v1/stream");
      expect(model.fps).toBe(20);
      expect(model.width).toBe(1088);
      expect(model.height).toBe(624);
    });

    it("lucy-restyle-latest works as realtime model", () => {
      const model = models.realtime("lucy-restyle-latest");
      expect(model.name).toBe("lucy-restyle-latest");
      expect(model.urlPath).toBe("/v1/stream");
      expect(model.fps).toBe(22);
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

    it("lucy-vton-latest works as video model", () => {
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

    it("lucy-motion-latest works as video model", () => {
      const model = models.video("lucy-motion-latest");
      expect(model.name).toBe("lucy-motion-latest");
      expect(model.urlPath).toBe("/v1/generate/lucy-motion-latest");
      expect(model.queueUrlPath).toBe("/v1/jobs/lucy-motion-latest");
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
      models.video("lucy-motion-latest");
      models.image("lucy-image-latest");

      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  describe("Dual-surface models", () => {
    it("lucy-2 is both a realtime and video model", () => {
      expect(isRealtimeModel("lucy-2")).toBe(true);
      expect(isVideoModel("lucy-2")).toBe(true);
    });

    it("lucy-2.1 is both a realtime and video model", () => {
      expect(isRealtimeModel("lucy-2.1")).toBe(true);
      expect(isVideoModel("lucy-2.1")).toBe(true);
    });

    it("lucy-2.1-vton is both a realtime and video model", () => {
      expect(isRealtimeModel("lucy-2.1-vton")).toBe(true);
      expect(isVideoModel("lucy-2.1-vton")).toBe(true);
    });

    it("lucy-restyle-2 is both a realtime and video model", () => {
      expect(isRealtimeModel("lucy-restyle-2")).toBe(true);
      expect(isVideoModel("lucy-restyle-2")).toBe(true);
    });
  });

  describe("Deprecated names still work", () => {
    it("lucy_2_rt still works as realtime model", () => {
      const model = models.realtime("lucy_2_rt");
      expect(model.name).toBe("lucy_2_rt");
    });

    it("mirage_v2 still works as realtime model", () => {
      const model = models.realtime("mirage_v2");
      expect(model.name).toBe("mirage_v2");
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
