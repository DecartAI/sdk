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

  it("honors an initial_state ack that arrives before room_info", async () => {
    const { SignalingChannel } = await import("../src/realtime/signaling-channel.js");

    let socket: MockWebSocket | null = null;

    class MockWebSocket {
      static OPEN = 1;
      readyState = MockWebSocket.OPEN;
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: ((event: { code: number; reason: string }) => void) | null = null;
      sent: string[] = [];

      constructor(_url: string) {
        socket = this;
        setTimeout(() => this.onopen?.(), 0);
      }

      send(data: string): void {
        this.sent.push(data);
      }
      close(): void {}
      deliver(message: object): void {
        this.onmessage?.({ data: JSON.stringify(message) });
      }
    }

    vi.stubGlobal("WebSocket", MockWebSocket as unknown as typeof WebSocket);

    try {
      const channel = new SignalingChannel({ url: "wss://example.com/realtime", logger });
      const joinPromise = channel.openAndJoin({
        initialState: { prompt: "a calm lake" },
        connectTimeout: 50,
        handshakeTimeout: 200,
      });

      await vi.waitFor(() => expect(socket?.sent.length ?? 0).toBeGreaterThan(0));
      const ws = socket as MockWebSocket;
      expect(JSON.parse(ws.sent[0])).toMatchObject({
        type: "livekit_join",
        initial_state: { type: "prompt", prompt: "a calm lake" },
      });

      ws.deliver({ type: "prompt_ack", prompt: "a calm lake", success: true });
      ws.deliver({
        type: "livekit_room_info",
        livekit_url: "wss://lk",
        token: "tok",
        room_name: "room",
        session_id: "sess",
      });

      const { initialStateAck } = await joinPromise;
      await expect(initialStateAck).resolves.toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("always sends the initial_state field (null when empty) as a capability marker", async () => {
    const { SignalingChannel } = await import("../src/realtime/signaling-channel.js");

    let socket: MockWebSocket | null = null;

    class MockWebSocket {
      static OPEN = 1;
      readyState = MockWebSocket.OPEN;
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: ((event: { code: number; reason: string }) => void) | null = null;
      sent: string[] = [];

      constructor(_url: string) {
        socket = this;
        setTimeout(() => this.onopen?.(), 0);
      }

      send(data: string): void {
        this.sent.push(data);
      }
      close(): void {}
      deliver(message: object): void {
        this.onmessage?.({ data: JSON.stringify(message) });
      }
    }

    vi.stubGlobal("WebSocket", MockWebSocket as unknown as typeof WebSocket);

    try {
      const channel = new SignalingChannel({ url: "wss://example.com/realtime", logger });
      const joinPromise = channel.openAndJoin({ connectTimeout: 50, handshakeTimeout: 200 });

      await vi.waitFor(() => expect(socket?.sent.length ?? 0).toBeGreaterThan(0));
      const ws = socket as MockWebSocket;
      const join = JSON.parse(ws.sent[0]);
      expect(join.type).toBe("livekit_join");
      expect("initial_state" in join).toBe(true);
      expect(join.initial_state).toBeNull();

      ws.deliver({
        type: "livekit_room_info",
        livekit_url: "wss://lk",
        token: "tok",
        room_name: "room",
        session_id: "sess",
      });
      await joinPromise;
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
