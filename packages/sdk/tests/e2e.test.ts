import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDecartClient, models, type QueueJobResult } from "@decartai/sdk";
import { beforeAll, describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const OUTPUT_DIR = join(__dirname, "e2e-output");
const VIDEO_FIXTURE = join(__dirname, "fixtures", "video.mp4");
const IMAGE_FIXTURE = join(__dirname, "fixtures", "image.png");

const TIMEOUT = 5 * 60 * 1000; // 5 minutes
describe.concurrent("E2E Tests", { timeout: TIMEOUT, retry: 2 }, () => {
  let client: ReturnType<typeof createDecartClient>;
  let videoBlob: Blob;
  let imageBlob: Blob;

  beforeAll(() => {
    const apiKey = process.env.DECART_API_KEY;
    if (!apiKey) {
      throw new Error("DECART_API_KEY environment variable not set. Run with: DECART_API_KEY=your_key pnpm test:e2e");
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

  async function saveOutput(result: Blob, modelName: string, ext: string): Promise<string> {
    const outputPath = join(OUTPUT_DIR, `${modelName}${ext}`);
    const buffer = Buffer.from(await result.arrayBuffer());
    writeFileSync(outputPath, buffer);
    return outputPath;
  }

  async function expectResult(result: Blob | QueueJobResult, modelName: string, ext: string): Promise<void> {
    let blob: Blob;
    if (result instanceof Blob) {
      blob = result;
    } else if (result.status === "failed") {
      throw new Error(`${modelName} job failed. job_id: ${result.job_id}`);
    } else {
      blob = result.data;
    }

    expect(blob).toBeInstanceOf(Blob);
    if (blob.size === 0) {
      throw new Error(`${modelName} returned empty blob`);
    }
    const path = await saveOutput(blob, modelName, ext);
    console.log(`Saved to: ${path}`);
  }

  describe("Process API - Image Models", () => {
    it("lucy-pro-i2i: image-to-image", async () => {
      const result = await client.process({
        model: models.image("lucy-pro-i2i"),
        prompt: "Oil painting in the style of Van Gogh",
        data: imageBlob,
        seed: 333,
        enhance_prompt: false,
      });

      await expectResult(result, "lucy-pro-i2i", ".png");
    });
  });

  describe("Queue API - Video Models", () => {
    it("lucy-pro-v2v: video-to-video", async () => {
      const result = await client.queue.submitAndPoll({
        model: models.video("lucy-pro-v2v"),
        prompt: "Lego World animated style",
        data: videoBlob,
        seed: 999,
        enhance_prompt: true,
      });

      await expectResult(result, "lucy-pro-v2v", ".mp4");
    });

    it("lucy-restyle-v2v: video restyling (prompt)", async () => {
      const result = await client.queue.submitAndPoll({
        model: models.video("lucy-restyle-v2v"),
        prompt: "Cyberpunk neon city style",
        data: videoBlob,
        seed: 777,
      });

      await expectResult(result, "lucy-restyle-v2v-prompt", ".mp4");
    });

    it("lucy-restyle-v2v: video restyling (reference_image)", async () => {
      const result = await client.queue.submitAndPoll({
        model: models.video("lucy-restyle-v2v"),
        reference_image: imageBlob,
        data: videoBlob,
        seed: 777,
      });

      await expectResult(result, "lucy-restyle-v2v-reference_image", ".mp4");
    });

    it("lucy-2-v2v: video editing (prompt)", async () => {
      const result = await client.queue.submitAndPoll({
        model: models.video("lucy-2-v2v"),
        prompt: "Watercolor painting style with soft brushstrokes",
        data: videoBlob,
        seed: 42,
      });

      await expectResult(result, "lucy-2-v2v-prompt", ".mp4");
    });

    it("lucy-2-v2v: video editing (reference_image)", async () => {
      const result = await client.queue.submitAndPoll({
        model: models.video("lucy-2-v2v"),
        prompt: "",
        reference_image: imageBlob,
        data: videoBlob,
        seed: 42,
      });

      await expectResult(result, "lucy-2-v2v-reference_image", ".mp4");
    });

    it("lucy-2-v2v: video editing (prompt + reference_image)", async () => {
      const result = await client.queue.submitAndPoll({
        model: models.video("lucy-2-v2v"),
        prompt: "Watercolor painting style",
        reference_image: imageBlob,
        data: videoBlob,
        seed: 42,
      });

      await expectResult(result, "lucy-2-v2v-both", ".mp4");
    });

    // Temporarily disabled in prod-usw2: lucy-motion-server is configured with enabled: false / replicas: 0.
    // Re-enable this E2E once the public lucy-motion queue has an active consumer again.
    it.skip("lucy-motion: motion-guided image-to-video", async () => {
      const result = await client.queue.submitAndPoll({
        model: models.video("lucy-motion"),
        data: imageBlob,
        trajectory: [
          { frame: 0, x: 0, y: 0 },
          { frame: 1, x: 0.1, y: 0.2 },
          { frame: 2, x: 0.2, y: 0.4 },
        ],
        seed: 555,
      });

      await expectResult(result, "lucy-motion", ".mp4");
    });
  });
});
