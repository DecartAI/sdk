import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "vitest";
import { createDecartClient, models } from "../src/index.js";

const MOCK_RESPONSE_DATA = new Uint8Array([0x00, 0x01, 0x02]).buffer;
const TEST_API_KEY = "test-api-key";
const BASE_URL = "http://localhost";

describe("Decart SDK", () => {
	describe("createDecartClient", () => {
		it("creates a client", () => {
			const decart = createDecartClient({
				apiKey: "test",
			});

			expect(decart).toBeDefined();
		});

		it("throws an error if the api key is not provided", () => {
			// biome-ignore lint/suspicious/noExplicitAny: invalid options to test
			expect(() => createDecartClient({} as any)).toThrow(
				"API key is required and must be a non-empty string",
			);
		});

		it("throws an error if invalid base url is provided", () => {
			expect(() =>
				createDecartClient({ apiKey: "test", baseUrl: "not-a-url" }),
			).toThrow("Invalid base URL");
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
			it("processes text-to-video", async () => {
				server.use(createMockHandler("/v1/generate/lucy-pro-t2v"));

				const result = await decart.process({
					model: models.video("lucy-pro-t2v"),
					prompt: "A cat playing piano",
					seed: 42,
				});

				expect(result).toBeInstanceOf(Blob);
				expect(lastRequest?.headers.get("x-api-key")).toBe(TEST_API_KEY);
				expect(lastFormData?.get("prompt")).toBe("A cat playing piano");
				expect(lastFormData?.get("seed")).toBe("42");
			});

			it("processes text-to-image", async () => {
				server.use(createMockHandler("/v1/generate/lucy-pro-t2i"));

				const result = await decart.process({
					model: models.image("lucy-pro-t2i"),
					prompt: "A beautiful landscape",
					seed: 123,
					resolution: "1920x1080",
				});

				expect(result).toBeInstanceOf(Blob);
				expect(lastRequest?.headers.get("x-api-key")).toBe(TEST_API_KEY);
				expect(lastFormData?.get("prompt")).toBe("A beautiful landscape");
				expect(lastFormData?.get("seed")).toBe("123");
				expect(lastFormData?.get("resolution")).toBe("1920x1080");
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

			it("processes image-to-video", async () => {
				server.use(createMockHandler("/v1/generate/lucy-pro-i2v"));

				const testImage = new Blob(["test-image"], { type: "image/png" });

				const result = await decart.process({
					model: models.video("lucy-pro-i2v"),
					prompt: "Animate this image",
					data: testImage,
					seed: 456,
				});

				expect(result).toBeInstanceOf(Blob);
				expect(lastRequest?.headers.get("x-api-key")).toBe(TEST_API_KEY);
				expect(lastFormData?.get("prompt")).toBe("Animate this image");
				expect(lastFormData?.get("seed")).toBe("456");

				const dataFile = lastFormData?.get("data") as File;
				expect(dataFile).toBeInstanceOf(File);
			});

			it("processes video-to-video", async () => {
				server.use(createMockHandler("/v1/generate/lucy-pro-v2v"));

				const testVideo = new Blob(["test-video"], { type: "video/mp4" });

				const result = await decart.process({
					model: models.video("lucy-pro-v2v"),
					prompt: "Transform video style",
					data: testVideo,
					enhance_prompt: true,
					num_inference_steps: 30,
				});

				expect(result).toBeInstanceOf(Blob);
				expect(lastRequest?.headers.get("x-api-key")).toBe(TEST_API_KEY);
				expect(lastFormData?.get("prompt")).toBe("Transform video style");
				expect(lastFormData?.get("enhance_prompt")).toBe("true");
				expect(lastFormData?.get("num_inference_steps")).toBe("30");

				const dataFile = lastFormData?.get("data") as File;
				expect(dataFile).toBeInstanceOf(File);
			});

			it("processes first-last-frame-to-video", async () => {
				server.use(createMockHandler("/v1/generate/lucy-pro-flf2v"));

				const startFrame = new Blob(["start-frame"], { type: "image/png" });
				const endFrame = new Blob(["end-frame"], { type: "image/png" });

				const result = await decart.process({
					model: models.video("lucy-pro-flf2v"),
					prompt: "Interpolate between frames",
					start: startFrame,
					end: endFrame,
				});

				expect(result).toBeInstanceOf(Blob);
				expect(lastRequest?.headers.get("x-api-key")).toBe(TEST_API_KEY);
				expect(lastFormData?.get("prompt")).toBe("Interpolate between frames");

				const startFile = lastFormData?.get("start") as File;
				const endFile = lastFormData?.get("end") as File;
				expect(startFile).toBeInstanceOf(File);
				expect(endFile).toBeInstanceOf(File);
			});

			it("processes dev image-to-video", async () => {
				server.use(createMockHandler("/v1/generate/lucy-dev-i2v"));

				const testImage = new Blob(["test-image"], { type: "image/png" });

				const result = await decart.process({
					model: models.video("lucy-dev-i2v"),
					prompt: "Dev version i2v",
					data: testImage,
				});

				expect(result).toBeInstanceOf(Blob);
				expect(lastRequest?.headers.get("x-api-key")).toBe(TEST_API_KEY);
				expect(lastFormData?.get("prompt")).toBe("Dev version i2v");

				const dataFile = lastFormData?.get("data") as File;
				expect(dataFile).toBeInstanceOf(File);
			});

			it("processes dev video-to-video", async () => {
				server.use(createMockHandler("/v1/generate/lucy-dev-v2v"));

				const testVideo = new Blob(["test-video"], { type: "video/mp4" });

				const result = await decart.process({
					model: models.video("lucy-dev-v2v"),
					prompt: "Dev version v2v",
					data: testVideo,
				});

				expect(result).toBeInstanceOf(Blob);
				expect(lastRequest?.headers.get("x-api-key")).toBe(TEST_API_KEY);
				expect(lastFormData?.get("prompt")).toBe("Dev version v2v");

				const dataFile = lastFormData?.get("data") as File;
				expect(dataFile).toBeInstanceOf(File);
			});
		});

		describe("Abort Signal", () => {
			it("supports abort signal", async () => {
				const controller = new AbortController();

				server.use(
					http.post(`${BASE_URL}/v1/generate/lucy-pro-t2v`, async () => {
						await new Promise((resolve) => setTimeout(resolve, 100));
						return HttpResponse.arrayBuffer(MOCK_RESPONSE_DATA, {
							headers: { "Content-Type": "application/octet-stream" },
						});
					}),
				);

				const processPromise = decart.process({
					model: models.video("lucy-pro-t2v"),
					prompt: "test",
					signal: controller.signal,
				});

				controller.abort();

				await expect(processPromise).rejects.toThrow();
			});
		});

		describe("Input Validation", () => {
			it("validates required inputs for text-to-video", async () => {
				await expect(
					// biome-ignore lint/suspicious/noExplicitAny: testing invalid input
					decart.process({
						model: models.video("lucy-pro-t2v"),
					} as any),
				).rejects.toThrow("Invalid inputs");
			});

			it("validates required inputs for image-to-image", async () => {
				await expect(
					// biome-ignore lint/suspicious/noExplicitAny: testing invalid input
					decart.process({
						model: models.image("lucy-pro-i2i"),
						prompt: "test",
					} as any),
				).rejects.toThrow("Invalid inputs");
			});
		});

		describe("Error Handling", () => {
			it("handles API errors", async () => {
				server.use(
					http.post(`${BASE_URL}/v1/generate/lucy-pro-t2v`, () => {
						return HttpResponse.text("Internal Server Error", { status: 500 });
					}),
				);

				await expect(
					decart.process({
						model: models.video("lucy-pro-t2v"),
						prompt: "test",
					}),
				).rejects.toThrow("Processing failed");
			});
		});
	});
});
