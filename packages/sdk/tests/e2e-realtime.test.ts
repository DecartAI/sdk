declare const __DECART_API_KEY__: string;

import { createDecartClient, type DecartSDKError, models, type RealTimeModels } from "@decartai/sdk";
import { beforeAll, describe, expect, it } from "vitest";

function createSyntheticStream(fps: number, width: number, height: number): MediaStream {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas.captureStream(fps);
}

const REALTIME_MODELS: RealTimeModels[] = ["mirage", "mirage_v2", "lucy_v2v_720p_rt", "lucy_2_rt"];

describe.concurrent("Realtime E2E Tests", { timeout: 30_000, retry: 2 }, () => {
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
      const stream = createSyntheticStream(model.fps, model.width, model.height);

      let remoteStreamReceived = false;

      const realtimeClient = await client.realtime.connect(stream, {
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

      try {
        expect(["connected", "generating"]).toContain(realtimeClient.getConnectionState());
        expect(realtimeClient.sessionId).toBeTruthy();
        expect(remoteStreamReceived).toBe(true);

        await realtimeClient.setPrompt("Cyberpunk city");

        expect(errors).toEqual([]);
      } finally {
        realtimeClient.disconnect();
      }

      expect(realtimeClient.getConnectionState()).toBe("disconnected");
    });
  }
});
