import { describe, expect, it } from "vitest";
import { createDecartClient } from "../src/index.js";

describe("Decart SDK", () => {
	describe("createDecartClient", () => {
		it("creates a client", () => {
			const decart = createDecartClient({
				apiKey: "test",
			});

			expect(decart).toBeDefined();
		});

		it("creates a client with a custom base url", () => {
			const decart = createDecartClient({
				baseUrl: "https://api.decart.ai",
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
});
