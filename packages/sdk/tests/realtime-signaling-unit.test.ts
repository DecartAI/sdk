import { describe, expect, it, vi } from "vitest";

const logger = { debug() {}, info() {}, warn() {}, error() {} };

describe("SignalingChannel", () => {
  it("rejects a failed reconnect attempt after close", async () => {
    const { SignalingChannel } = await import("../src/realtime/signaling-channel.js");

    class ClosingWebSocket {
      static OPEN = 1;
      readyState = ClosingWebSocket.OPEN;
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: ((event: { code: number; reason: string }) => void) | null = null;

      constructor(_url: string) {
        setTimeout(() => this.onclose?.({ code: 1006, reason: "network failure" }), 0);
      }

      send(): void {}
      close(): void {}
    }

    vi.stubGlobal("WebSocket", ClosingWebSocket as unknown as typeof WebSocket);

    try {
      const channel = new SignalingChannel({ url: "wss://example.com/realtime", logger });
      channel.close();

      const outcome = await Promise.race([
        channel.openAndJoin({ connectTimeout: 50, handshakeTimeout: 50 }).then(
          () => "resolved",
          (error: Error) => error.message,
        ),
        new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 25)),
      ]);

      expect(outcome).toContain("WebSocket closed: 1006 network failure");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
