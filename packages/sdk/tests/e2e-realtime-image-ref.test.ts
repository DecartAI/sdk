/**
 * E2E for the new file-upload + image_ref realtime flow against a local bouncer.
 *
 * Prereqs:
 *   - bouncer running locally on http://127.0.0.1:8000 with the new /v1/files
 *     endpoints and `image_ref` support in set_image
 *   - DECART_API_KEY set to an enabled apikey row for adir@decart.ai
 *
 * Run:
 *   DECART_API_KEY=<key> pnpm test:e2e:image-ref
 */

declare const __DECART_API_KEY__: string;

import { createDecartClient, type DecartSDKError, models } from "@decartai/sdk";
import { beforeAll, describe, expect, it } from "vitest";

const LOCAL_HTTP = "http://127.0.0.1:8000";
const LOCAL_WS = "ws://127.0.0.1:8000";

function createSyntheticStream(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas context unavailable");

  let frame = 0;
  const draw = () => {
    ctx.fillStyle = `hsl(${(frame * 5) % 360}, 80%, 45%)`;
    ctx.fillRect(0, 0, width, height);
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

function pngBlob(width: number, height: number, color = "#3070C0"): Promise<Blob> {
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

function waitUntil(condition: () => boolean, message: string, timeoutMs = 30_000): Promise<void> {
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

describe("Files API + realtime image_ref (against local bouncer)", { timeout: 60_000 }, () => {
  let client: ReturnType<typeof createDecartClient>;

  beforeAll(() => {
    const apiKey = __DECART_API_KEY__;
    if (!apiKey) {
      throw new Error("Set DECART_API_KEY to run this test");
    }
    client = createDecartClient({ apiKey, baseUrl: LOCAL_HTTP, realtimeBaseUrl: LOCAL_WS });
  });

  it("uploads a file, gets a reference, and reads it back", async () => {
    const blob = await pngBlob(96, 96);

    const ref = await client.files.upload(blob);
    expect(ref.id).toMatch(/^file_/);
    expect(ref.mime_type).toBe("image/png");
    expect(ref.size_bytes).toBeGreaterThan(0);

    const fetched = await client.files.get(ref.id);
    expect(fetched.id).toBe(ref.id);

    await client.files.delete(ref.id);
    await expect(client.files.get(ref.id)).rejects.toThrow(/Failed to get file/);
  });

  it("opens realtime with initialState.image set to a file reference id", async () => {
    const model = models.realtime("lucy-2.1");
    const blob = await pngBlob(model.width, model.height);
    const ref = await client.files.upload(blob);

    const synthetic = createSyntheticStream(model.width, model.height);
    let remoteStreamReceived = false;
    let realtimeClient: Awaited<ReturnType<typeof client.realtime.connect>> | undefined;
    const errors: DecartSDKError[] = [];

    try {
      realtimeClient = await client.realtime.connect(synthetic.stream, {
        model,
        initialState: { image: ref.id, prompt: { text: "make it cinematic", enhance: false } },
        onRemoteStream: () => {
          remoteStreamReceived = true;
        },
      });

      realtimeClient.on("error", (err) => errors.push(err));

      expect(["connected", "generating"]).toContain(realtimeClient.getConnectionState());
      expect(realtimeClient.sessionId).toBeTruthy();

      await waitUntil(() => remoteStreamReceived, "Timed out waiting for remote stream from upstream");
      expect(errors).toEqual([]);
    } finally {
      realtimeClient?.disconnect();
      synthetic.stop();
      try {
        await client.files.delete(ref.id);
      } catch {
        // best-effort cleanup
      }
    }
  });

  it("rt.set({ image: ref.id }) swaps the reference image mid-session", async () => {
    const model = models.realtime("lucy-2.1");
    const blobA = await pngBlob(model.width, model.height, "#3070C0");
    const blobB = await pngBlob(model.width, model.height, "#C03070");
    const refA = await client.files.upload(blobA);
    const refB = await client.files.upload(blobB);

    const synthetic = createSyntheticStream(model.width, model.height);
    let realtimeClient: Awaited<ReturnType<typeof client.realtime.connect>> | undefined;

    try {
      realtimeClient = await client.realtime.connect(synthetic.stream, {
        model,
        initialState: { image: refA.id, prompt: { text: "anime style", enhance: false } },
        onRemoteStream: () => {},
      });

      await realtimeClient.set({ image: refB.id, prompt: "noir" });
    } finally {
      realtimeClient?.disconnect();
      synthetic.stop();
      await Promise.allSettled([client.files.delete(refA.id), client.files.delete(refB.id)]);
    }
  });
});
