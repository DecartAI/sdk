declare const __DECART_API_KEY__: string;

import { createDecartClient, type DecartSDKError, models, type RealTimeModels } from "@decartai/sdk";
import { beforeAll, describe, expect, it } from "vitest";

function createSyntheticStream(width: number, height: number): { stream: MediaStream; stop: () => void } {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas context unavailable");

  let frame = 0;
  const draw = () => {
    ctx.fillStyle = `hsl(${(frame * 5) % 360}, 80%, 45%)`;
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
    ctx.fillRect((frame * 7) % Math.max(1, width - 160), 32, 140, 100);
    ctx.fillStyle = "rgba(0, 0, 0, 0.85)";
    ctx.font = "32px sans-serif";
    ctx.fillText(`${width}x${height}`, 48, 92);
    ctx.fillText(`frame ${frame}`, 48, 136);
    frame += 1;
  };

  draw();
  const intervalId = window.setInterval(draw, 1000 / 30);
  const stream = canvas.captureStream(30);

  return {
    stream,
    stop: () => {
      window.clearInterval(intervalId);
      for (const track of stream.getTracks()) track.stop();
    },
  };
}

function waitUntil(condition: () => boolean, message: string, timeoutMs = 15_000): Promise<void> {
  if (condition()) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const intervalId = window.setInterval(() => {
      if (!condition()) return;
      window.clearInterval(intervalId);
      window.clearTimeout(timeoutId);
      resolve();
    }, 50);

    const timeoutId = window.setTimeout(() => {
      window.clearInterval(intervalId);
      reject(new Error(message));
    }, timeoutMs);
  });
}

const REALTIME_MODELS: RealTimeModels[] = [
  // Actively served realtime video models and supported aliases.
  "lucy-restyle-2",
  "lucy-2.1",
  "lucy-vton-2",
  "lucy-vton-3",
  "mirage_v2",
];

const TIMEOUT = 1 * 60 * 1000; // 1 minute
describe.concurrent("Realtime E2E Tests", { timeout: TIMEOUT, retry: 2 }, () => {
  let client: ReturnType<typeof createDecartClient>;

  beforeAll(() => {
    // Injected at build time via vitest.config.e2e-realtime.ts `define`
    const apiKey = __DECART_API_KEY__;
    if (!apiKey) {
      throw new Error(
        "DECART_API_KEY environment variable not set. Run with: DECART_API_KEY=your_key pnpm test:e2e:realtime",
      );
    }
    client = createDecartClient({ apiKey });
  });

  for (const modelName of REALTIME_MODELS) {
    it(modelName, async () => {
      const model = models.realtime(modelName);
      const syntheticStream = createSyntheticStream(model.width, model.height);

      let remoteStreamReceived = false;
      let realtimeClient: Awaited<ReturnType<typeof client.realtime.connect>> | undefined;

      try {
        realtimeClient = await client.realtime.connect(syntheticStream.stream, {
          model,
          onRemoteStream: () => {
            remoteStreamReceived = true;
          },
          initialState: {
            prompt: { text: "Anime style", enhance: false },
          },
        });

        const errors: DecartSDKError[] = [];
        realtimeClient.on("error", (err) => errors.push(err));

        expect(["connected", "generating"]).toContain(realtimeClient.getConnectionState());
        expect(realtimeClient.sessionId).toBeTruthy();

        await waitUntil(() => remoteStreamReceived, `Timed out waiting for remote stream callback for ${modelName}`);
        expect(remoteStreamReceived).toBe(true);

        await realtimeClient.setPrompt("Cyberpunk city");

        expect(errors).toEqual([]);
      } finally {
        realtimeClient?.disconnect();
        syntheticStream.stop();
      }

      expect(realtimeClient?.getConnectionState()).toBe("disconnected");
    });
  }

  // POST /v1/files + image_ref via realtime. Uses lucy-2.1 to actually exercise
  // upstream forwarding through the bouncer's image_ref prologue.
  describe("Files API + image_ref", () => {
    async function pngBlob(width: number, height: number, color = "#3070C0"): Promise<Blob> {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("2D canvas context unavailable");
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, width, height);
      return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("toBlob failed"))), "image/png");
      });
    }

    it("upload → get → delete round-trip", async () => {
      const ref = await client.files.upload(await pngBlob(96, 96));
      expect(ref.id).toMatch(/^file_/);
      expect(ref.mime_type).toBe("image/png");

      const fetched = await client.files.get(ref.id);
      expect(fetched.id).toBe(ref.id);

      await client.files.delete(ref.id);
      await expect(client.files.get(ref.id)).rejects.toThrow(/Failed to get file/);
    });

    it("connects with initialState.image = ref.id", async () => {
      const model = models.realtime("lucy-2.1");
      const ref = await client.files.upload(await pngBlob(model.width, model.height));
      const syntheticStream = createSyntheticStream(model.width, model.height);

      let remoteStreamReceived = false;
      let realtimeClient: Awaited<ReturnType<typeof client.realtime.connect>> | undefined;
      const errors: DecartSDKError[] = [];

      try {
        realtimeClient = await client.realtime.connect(syntheticStream.stream, {
          model,
          initialState: { image: ref.id, prompt: { text: "make it cinematic", enhance: false } },
          onRemoteStream: () => {
            remoteStreamReceived = true;
          },
        });
        realtimeClient.on("error", (err) => errors.push(err));

        expect(["connected", "generating"]).toContain(realtimeClient.getConnectionState());
        await waitUntil(() => remoteStreamReceived, "Timed out waiting for remote stream via image_ref");
        expect(errors).toEqual([]);
      } finally {
        realtimeClient?.disconnect();
        syntheticStream.stop();
        await client.files.delete(ref.id).catch(() => {});
      }
    });

    it("rt.set({ image: ref.id }) swaps the reference image mid-session", async () => {
      const model = models.realtime("lucy-2.1");
      const [refA, refB] = await Promise.all([
        client.files.upload(await pngBlob(model.width, model.height, "#3070C0")),
        client.files.upload(await pngBlob(model.width, model.height, "#C03070")),
      ]);
      const syntheticStream = createSyntheticStream(model.width, model.height);
      let realtimeClient: Awaited<ReturnType<typeof client.realtime.connect>> | undefined;

      try {
        realtimeClient = await client.realtime.connect(syntheticStream.stream, {
          model,
          initialState: { image: refA.id, prompt: { text: "anime style", enhance: false } },
          onRemoteStream: () => {},
        });
        await realtimeClient.set({ image: refB.id, prompt: "noir" });
      } finally {
        realtimeClient?.disconnect();
        syntheticStream.stop();
        await Promise.allSettled([client.files.delete(refA.id), client.files.delete(refB.id)]);
      }
    });
  });
});
