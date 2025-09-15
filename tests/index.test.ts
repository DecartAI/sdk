import { describe, expect, it } from "vitest";
import { createDecartClient } from "../src/index.js";

describe("Decart SDK", () => {
	describe("createDecartClient", () => {
		it("creates a client", () => {
			const decart = createDecartClient({});

			expect(decart).toBeDefined();
		});

		it("creates a client with a custom base url", () => {
			const decart = createDecartClient({
				baseUrl: "https://api.decart.ai",
			});

			expect(decart).toBeDefined();
		});

		it("throws an error if invalid base url is provided", () => {
			expect(() =>
				createDecartClient({ baseUrl: "not-a-url" }),
			).toThrow("Invalid base URL");
		});
	});
});
