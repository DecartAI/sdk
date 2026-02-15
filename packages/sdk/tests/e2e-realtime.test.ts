declare const __DECART_API_KEY__: string;

import { type ConnectionState, createDecartClient, models, type RealTimeClient } from "@decartai/sdk";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

/**
 * Create a synthetic MediaStream from an offscreen canvas.
 * This avoids needing a real camera — works in headless Chromium.
 */
function createSyntheticStream(fps: number, width: number, height: number): MediaStream {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  // Draw something so frames aren't blank
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#1a1a2e";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#e94560";
  ctx.font = "48px sans-serif";
  ctx.fillText("E2E Test", 40, 80);

  return canvas.captureStream(fps);
}

/**
 * Wait for a specific connection state, with timeout.
 */
function waitForState(
  client: RealTimeClient,
  target: ConnectionState | ConnectionState[],
  timeoutMs = 30_000,
): Promise<ConnectionState> {
  const targets = Array.isArray(target) ? target : [target];

  return new Promise((resolve, reject) => {
    // Already in target state
    const current = client.getConnectionState();
    if (targets.includes(current)) {
      resolve(current);
      return;
    }

    const timeout = setTimeout(() => {
      client.off("connectionChange", listener);
      reject(new Error(`Timed out waiting for state [${targets.join(", ")}], current: ${client.getConnectionState()}`));
    }, timeoutMs);

    const listener = (state: ConnectionState) => {
      if (targets.includes(state)) {
        clearTimeout(timeout);
        client.off("connectionChange", listener);
        resolve(state);
      }
    };

    client.on("connectionChange", listener);
  });
}

const REALTIME_MODELS = ["mirage", "mirage_v2", "lucy_v2v_720p_rt", "lucy_2_rt"] as const;

describe("Realtime E2E Tests", { timeout: 120_000 }, () => {
  let client: ReturnType<typeof createDecartClient>;
  let activeClient: RealTimeClient | null = null;

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

  afterEach(() => {
    if (activeClient) {
      activeClient.disconnect();
      activeClient = null;
    }
  });

  for (const modelName of REALTIME_MODELS) {
    describe(modelName, () => {
      it("connects, sends prompt, and disconnects", async () => {
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
        activeClient = realtimeClient;

        // Wait for connected or generating state
        const connectedState = await waitForState(realtimeClient, ["connected", "generating"]);
        expect(["connected", "generating"]).toContain(connectedState);

        // Verify sessionId is assigned
        expect(realtimeClient.sessionId).toBeTruthy();
        console.log(`${modelName}: sessionId=${realtimeClient.sessionId}`);

        // Verify remote stream was received
        expect(remoteStreamReceived).toBe(true);

        // Send a prompt and wait for ack
        await realtimeClient.setPrompt("Cyberpunk city");

        // Disconnect and verify state
        realtimeClient.disconnect();
        activeClient = null;

        expect(realtimeClient.getConnectionState()).toBe("disconnected");
        console.log(`${modelName}: passed`);
      });
    });
  }
});
