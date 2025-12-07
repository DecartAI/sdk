import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDecartClient, models } from "@decartai/sdk";
import { beforeAll, describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const OUTPUT_DIR = join(__dirname, "e2e-output");
const VIDEO_FIXTURE = join(__dirname, "fixtures", "video.mp4");
const IMAGE_FIXTURE = join(__dirname, "fixtures", "image.png");

describe("E2E Tests", { timeout: 120_000 }, () => {
	let client: ReturnType<typeof createDecartClient>;
	let videoBlob: Blob;
	let imageBlob: Blob;

	beforeAll(() => {
		const apiKey = process.env.DECART_API_KEY;
		if (!apiKey) {
			throw new Error(
				"DECART_API_KEY environment variable not set. Run with: DECART_API_KEY=your_key pnpm test:e2e",
			);
		}

		// create the output directory, clean up if it exists
		if (existsSync(OUTPUT_DIR)) {
			rmSync(OUTPUT_DIR, { recursive: true });
		}
		mkdirSync(OUTPUT_DIR, { recursive: true });

		client = createDecartClient({
			apiKey,
		});

		const videoBuffer = readFileSync(VIDEO_FIXTURE);
		const imageBuffer = readFileSync(IMAGE_FIXTURE);
		videoBlob = new Blob([videoBuffer], { type: "video/mp4" });
		imageBlob = new Blob([imageBuffer], { type: "image/png" });
	});

	async function saveOutput(
		result: Blob,
		modelName: string,
		ext: string,
	): Promise<string> {
		const outputPath = join(OUTPUT_DIR, `${modelName}${ext}`);
		const buffer = Buffer.from(await result.arrayBuffer());
		writeFileSync(outputPath, buffer);
		return outputPath;
	}

	describe("Process API - Image Models", () => {
		it("lucy-pro-t2i: text-to-image", async () => {
			const result = await client.process({
				model: models.image("lucy-pro-t2i"),
				prompt:
					"A serene Japanese garden with cherry blossoms and a wooden bridge",
				seed: 222,
				orientation: "landscape",
			});

			expect(result).toBeInstanceOf(Blob);
			const path = await saveOutput(result, "lucy-pro-t2i", ".png");
			console.log(`Saved to: ${path}`);
		});

		it("lucy-pro-i2i: image-to-image", async () => {
			const result = await client.process({
				model: models.image("lucy-pro-i2i"),
				prompt: "Oil painting in the style of Van Gogh",
				data: imageBlob,
				seed: 333,
				enhance_prompt: false,
			});

			expect(result).toBeInstanceOf(Blob);
			const path = await saveOutput(result, "lucy-pro-i2i", ".png");
			console.log(`Saved to: ${path}`);
		});
	});

	describe("Queue API - Video Models", () => {
		it("lucy-pro-t2v: text-to-video", async () => {
			const result = await client.queue.submitAndPoll({
				model: models.video("lucy-pro-t2v"),
				prompt: "A majestic eagle soaring through mountain peaks at sunset",
				seed: 42,
				resolution: "720p",
				orientation: "landscape",
			});

			expect(result.status).toBe("completed");
			if (result.status === "completed") {
				const path = await saveOutput(result.data, "lucy-pro-t2v", ".mp4");
				console.log(`Saved to: ${path}`);
			}
		});

		it("lucy-dev-i2v: image-to-video (dev)", async () => {
			const result = await client.queue.submitAndPoll({
				model: models.video("lucy-dev-i2v"),
				prompt: "The image comes to life with gentle movements",
				data: imageBlob,
				seed: 123,
				resolution: "720p",
			});

			expect(result.status).toBe("completed");
			if (result.status === "completed") {
				const path = await saveOutput(result.data, "lucy-dev-i2v", ".mp4");
				console.log(`Saved to: ${path}`);
			}
		});

		it("lucy-pro-i2v: image-to-video (pro)", async () => {
			const result = await client.queue.submitAndPoll({
				model: models.video("lucy-pro-i2v"),
				prompt: "Transform the image into a dynamic video scene",
				data: imageBlob,
				seed: 456,
				resolution: "720p",
			});

			expect(result.status).toBe("completed");
			if (result.status === "completed") {
				const path = await saveOutput(result.data, "lucy-pro-i2v", ".mp4");
				console.log(`Saved to: ${path}`);
			}
		});

		it("lucy-pro-v2v: video-to-video", async () => {
			const result = await client.queue.submitAndPoll({
				model: models.video("lucy-pro-v2v"),
				prompt: "Lego World animated style",
				data: videoBlob,
				seed: 999,
				enhance_prompt: true,
				num_inference_steps: 5,
			});

			expect(result.status).toBe("completed");
			if (result.status === "completed") {
				const path = await saveOutput(result.data, "lucy-pro-v2v", ".mp4");
				console.log(`Saved to: ${path}`);
			}
		});

		it.skip("lucy-pro-flf2v: first-last-frame-to-video", async () => {
			const result = await client.queue.submitAndPoll({
				model: models.video("lucy-pro-flf2v"),
				prompt: "Smooth cinematic transition between frames",
				start: imageBlob,
				end: imageBlob,
				seed: 111,
				resolution: "720p",
			});

			expect(result.status).toBe("completed");
			if (result.status === "completed") {
				const path = await saveOutput(result.data, "lucy-pro-flf2v", ".mp4");
				console.log(`Saved to: ${path}`);
			}
		});
	});
});
