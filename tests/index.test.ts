import { describe, expect, it } from "vitest";
import { createMirageClient } from "../src/index.js";

describe("Mirage SDK", () => {
	describe("createMirageClient", () => {
		it("creates a client", () => {
			const mirage = createMirageClient({
				apiKey: "test",
			});

			expect(mirage).toBeDefined();
		});

		it("throws an error if the api key is not provided", () => {
			// biome-ignore lint/suspicious/noExplicitAny: invalid options to test
			expect(() => createMirageClient({} as any)).toThrow(
				"API key is required and must be a non-empty string",
			);
		});

		it("throws an error if invalid base url is provided", () => {
			expect(() =>
				createMirageClient({ apiKey: "test", baseUrl: "not-a-url" }),
			).toThrow("Invalid base URL");
		});
	});
});
