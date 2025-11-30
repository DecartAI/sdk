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
				expect(userAgent).toMatch(
					/^decart-js-sdk\/[\d.]+-?\w* lang\/js runtime\/[\w./]+$/,
				);
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
				expect(userAgent).toMatch(
					/^decart-js-sdk\/[\d.]+-?\w* lang\/js vercel-ai-sdk\/3\.0\.0 runtime\/[\w./]+$/,
				);
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
					// biome-ignore lint/suspicious/noExplicitAny: testing invalid input
					decart.process({
						model: models.image("lucy-pro-t2i"),
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
		it("submits a job and returns job info", async () => {
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

		it("validates required inputs", async () => {
			await expect(
				// biome-ignore lint/suspicious/noExplicitAny: testing invalid input
				decart.queue.submit({
					model: models.video("lucy-pro-t2v"),
				} as any),
			).rejects.toThrow("Invalid inputs");
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

			await expect(decart.queue.status("job_123")).rejects.toThrow(
				"Failed to get job status",
			);
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

			await expect(decart.queue.result("job_123")).rejects.toThrow(
				"Failed to get job content",
			);
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

		expect(userAgent).toEqual(
			`decart-js-sdk/${VERSION} lang/js runtime/node.js/${process.version}`,
		);
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
		const { getRuntimeEnvironment } = await import(
			"../src/utils/user-agent.js"
		);

		// Test browser detection
		const mockBrowser = { window: {} };
		expect(getRuntimeEnvironment(mockBrowser)).toEqual("runtime/browser");

		// Test Node.js < 21.1 detection (no navigator.userAgent)
		const mockNodeOld = {
			process: { versions: { node: true }, version: "v18.0.0" },
		};
		expect(getRuntimeEnvironment(mockNodeOld)).toEqual(
			"runtime/node.js/v18.0.0",
		);

		// Test Node.js >= 21.1 and other runtimes detection (has navigator.userAgent)
		const mockNodeNew = {
			navigator: { userAgent: "Node.js/v22.0.0" },
		};
		expect(getRuntimeEnvironment(mockNodeNew)).toEqual(
			"runtime/node.js/v22.0.0",
		);

		// Test Vercel Edge detection (no navigator.userAgent, has EdgeRuntime)
		const mockEdge = { EdgeRuntime: true };
		expect(getRuntimeEnvironment(mockEdge)).toEqual("runtime/vercel-edge");

		// Test unknown runtime
		const mockUnknown = {};
		expect(getRuntimeEnvironment(mockUnknown)).toEqual("runtime/unknown");
	});
});
