declare const __DECART_API_KEY__: string;
declare const __WEBRTC_BASE_URL__: string;

import {
  createDecartClient,
  type CustomModelDefinition,
  type DecartSDKError,
  type SelectedCandidatePairEvent,
} from "@decartai/sdk";
import { beforeAll, describe, expect, it } from "vitest";

function createSyntheticStream(fps: number, width: number, height: number): MediaStream {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas.captureStream(fps);
}

const BIT_INVERT_MODEL: CustomModelDefinition = {
  name: "bit_invert",
  urlPath: "/ws",
  fps: 25,
  width: 512,
  height: 512,
};

const TURN_ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "turn:127.0.0.1:3478?transport=tcp", username: "turn", credential: "turn" },
];

const TIMEOUT = 2 * 60 * 1000; // 2 minutes

/**
 * Wraps the global RTCPeerConnection so every new instance uses
 * the given iceTransportPolicy. Returns a cleanup function to restore.
 */
function overrideIceTransportPolicy(policy: RTCIceTransportPolicy): () => void {
  const OriginalPC = globalThis.RTCPeerConnection;
  globalThis.RTCPeerConnection = class extends OriginalPC {
    constructor(config?: RTCConfiguration) {
      super({ ...config, iceTransportPolicy: policy });
    }
  } as typeof RTCPeerConnection;
  return () => {
    globalThis.RTCPeerConnection = OriginalPC;
  };
}

/**
 * Collects the selectedCandidatePair diagnostic from a realtime client.
 * The event is buffered during connect() and flushed via setTimeout(0)
 * after connect() resolves, so registering immediately catches it.
 */
function collectSelectedCandidatePair(
  realtimeClient: { on: (event: "diagnostic", handler: (e: { name: string; data: unknown }) => void) => void },
): Promise<SelectedCandidatePairEvent | null> {
  return new Promise((resolve) => {
    const handler = (event: { name: string; data: unknown }) => {
      if (event.name === "selectedCandidatePair") {
        resolve(event.data as SelectedCandidatePairEvent);
      }
    };
    realtimeClient.on("diagnostic", handler);
    // Fallback: if the event was already emitted before we registered, resolve after a delay
    setTimeout(() => resolve(null), 5000);
  });
}

describe("TURN-TCP E2E Tests", { timeout: TIMEOUT, retry: 2 }, () => {
  let apiKey: string;
  let webrtcBaseUrl: string;

  beforeAll(() => {
    apiKey = __DECART_API_KEY__;
    webrtcBaseUrl = __WEBRTC_BASE_URL__;
    if (!apiKey) {
      throw new Error(
        "DECART_API_KEY environment variable not set. Run with: DECART_API_KEY=your_key pnpm test:e2e:turn-tcp",
      );
    }
    if (!webrtcBaseUrl) {
      throw new Error(
        "WEBRTC_BASE_URL environment variable not set. Set it to your local k8s WebSocket URL.",
      );
    }
  });

  // Requires server-side aioice TURN-TCP allocation to work (server must produce relay candidates).
  // Skip until server-side TURN candidate generation is verified.
  it.skip("TURN-TCP relay only (iceTransportPolicy=relay)", async () => {
    const restore = overrideIceTransportPolicy("relay");

    try {
      const client = createDecartClient({ apiKey, realtimeBaseUrl: webrtcBaseUrl });
      const stream = createSyntheticStream(BIT_INVERT_MODEL.fps, BIT_INVERT_MODEL.width, BIT_INVERT_MODEL.height);

      let remoteStreamReceived = false;

      const realtimeClient = await client.realtime.connect(stream, {
        model: BIT_INVERT_MODEL,
        onRemoteStream: () => {
          remoteStreamReceived = true;
        },
        iceServers: TURN_ICE_SERVERS,
      });

      // Register diagnostic listener immediately - buffered events flush on next macrotask
      const candidatePairPromise = collectSelectedCandidatePair(realtimeClient);

      const errors: DecartSDKError[] = [];
      realtimeClient.on("error", (err) => errors.push(err));

      try {
        expect(["connected", "generating"]).toContain(realtimeClient.getConnectionState());
        expect(realtimeClient.sessionId).toBeTruthy();
        expect(remoteStreamReceived).toBe(true);
        expect(errors).toEqual([]);

        // With relay-only policy, the selected candidate must be a relay (TURN)
        const pair = await candidatePairPromise;
        if (pair) {
          expect(pair.local.candidateType).toBe("relay");
        }
      } finally {
        realtimeClient.disconnect();
        for (const track of stream.getTracks()) track.stop();
      }

      expect(realtimeClient.getConnectionState()).toBe("disconnected");
    } finally {
      restore();
    }
  });

  it("Both UDP + TURN available (default iceTransportPolicy=all)", async () => {
    const client = createDecartClient({ apiKey, realtimeBaseUrl: webrtcBaseUrl });
    const stream = createSyntheticStream(BIT_INVERT_MODEL.fps, BIT_INVERT_MODEL.width, BIT_INVERT_MODEL.height);

    let remoteStreamReceived = false;

    const realtimeClient = await client.realtime.connect(stream, {
      model: BIT_INVERT_MODEL,
      onRemoteStream: () => {
        remoteStreamReceived = true;
      },
      iceServers: TURN_ICE_SERVERS,
    });

    // Register diagnostic listener immediately
    const candidatePairPromise = collectSelectedCandidatePair(realtimeClient);

    const errors: DecartSDKError[] = [];
    realtimeClient.on("error", (err) => errors.push(err));

    try {
      expect(["connected", "generating"]).toContain(realtimeClient.getConnectionState());
      expect(realtimeClient.sessionId).toBeTruthy();
      expect(remoteStreamReceived).toBe(true);
      expect(errors).toEqual([]);

      // With default policy, ICE should prefer direct UDP over relay.
      // In Docker/NAT environments, the local candidate may appear as "prflx"
      // (peer-reflexive) rather than "host", but it should NOT be "relay".
      const pair = await candidatePairPromise;
      if (pair) {
        expect(pair.local.candidateType).not.toBe("relay");
      }
    } finally {
      realtimeClient.disconnect();
      for (const track of stream.getTracks()) track.stop();
    }

    expect(realtimeClient.getConnectionState()).toBe("disconnected");
  });
});
