import { describe, expect, it, vi } from "vitest";
import { models } from "../src/index.js";

type ConnectionState = import("../src/realtime/types.js").ConnectionState;
type IncomingRealtimeMessage = import("../src/realtime/types.js").IncomingRealtimeMessage;

type FakeWebSocketInstance = {
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onerror: (() => void) | null;
  onclose: ((event: { code: number; reason: string; wasClean?: boolean }) => void) | null;
  emitMessage: (message: IncomingRealtimeMessage) => void;
  close: () => void;
};

function installFakeWebSocket(onSend?: (ws: FakeWebSocketInstance, message: { type: string }) => void): {
  instances: FakeWebSocketInstance[];
  sentMessages: Array<{ type: string }>;
} {
  const instances: FakeWebSocketInstance[] = [];
  const sentMessages: Array<{ type: string }> = [];

  class FakeWebSocket implements FakeWebSocketInstance {
    static OPEN = 1;
    static CLOSED = 3;
    readyState = FakeWebSocket.OPEN;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: ((event: { code: number; reason: string; wasClean?: boolean }) => void) | null = null;

    constructor(_url: string) {
      instances.push(this);
      setTimeout(() => this.onopen?.(), 0);
    }

    send(data: string): void {
      const message = JSON.parse(data) as { type: string };
      sentMessages.push(message);
      onSend?.(this, message);
    }

    emitMessage(message: IncomingRealtimeMessage): void {
      this.onmessage?.({ data: JSON.stringify(message) });
    }

    close(): void {
      this.readyState = FakeWebSocket.CLOSED;
      this.onclose?.({ code: 1000, reason: "", wasClean: true });
    }
  }

  vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
  return { instances, sentMessages };
}

describe("LiveKitConnection", () => {
  describe("connect startup conditioning", () => {
    it("sends initial image with the initial prompt after joining the LiveKit room", async () => {
      const { LiveKitConnection } = await import("../src/realtime/livekit-connection.js");
      const { sentMessages } = installFakeWebSocket((ws, message) => {
        if (message.type === "livekit_join") {
          setTimeout(
            () =>
              ws.emitMessage({
                type: "livekit_room_info",
                livekit_url: "wss://livekit.example.com",
                token: "token",
                room_name: "room",
              }),
            0,
          );
        }
      });

      try {
        const connection = new LiveKitConnection({
          initialImage: "base64-image",
          initialPrompt: { text: "Anime", enhance: false },
        });
        const internal = connection as unknown as {
          joinRoom: (info: unknown) => Promise<void>;
        };
        const joinSpy = vi.spyOn(internal, "joinRoom").mockResolvedValue(undefined);
        const imageSpy = vi.spyOn(connection, "setImageBase64").mockResolvedValue(undefined);

        await connection.connect("wss://example.com/v1/stream", {} as MediaStream, 750);

        expect(sentMessages).toContainEqual({ type: "livekit_join" });
        expect(joinSpy).toHaveBeenCalledWith({
          type: "livekit_room_info",
          livekit_url: "wss://livekit.example.com",
          token: "token",
          room_name: "room",
        });
        expect(imageSpy).toHaveBeenCalledWith("base64-image", { prompt: "Anime", enhance: false });
        expect(connection.state).toBe("connected");

        joinSpy.mockRestore();
        imageSpy.mockRestore();
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("surfaces server error control messages", async () => {
      const { LiveKitConnection } = await import("../src/realtime/livekit-connection.js");
      const onError = vi.fn();
      const connection = new LiveKitConnection({ onError });
      const internal = connection as unknown as {
        handleControlMessage: (msg: { type: "error"; error: string }) => void;
      };

      internal.handleControlMessage({ type: "error", error: "server unavailable" });

      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError.mock.calls[0][0]).toMatchObject({
        message: "server unavailable",
        source: "server",
      });
    });

    it("aborts connect when a server error arrives during startup conditioning", async () => {
      const { LiveKitConnection } = await import("../src/realtime/livekit-connection.js");
      installFakeWebSocket((ws, message) => {
        if (message.type === "livekit_join") {
          setTimeout(
            () =>
              ws.emitMessage({
                type: "livekit_room_info",
                livekit_url: "wss://livekit.example.com",
                token: "token",
                room_name: "room",
              }),
            0,
          );
        }
      });

      try {
        const onError = vi.fn();
        const connection = new LiveKitConnection({ initialImage: "base64-image", onError });
        const internal = connection as unknown as {
          handleControlMessage: (msg: { type: "error"; error: string }) => void;
          joinRoom: (info: unknown) => Promise<void>;
        };
        const joinSpy = vi.spyOn(internal, "joinRoom").mockResolvedValue(undefined);
        const imageSpy = vi.spyOn(connection, "setImageBase64").mockReturnValue(new Promise<void>(() => {}));

        const connectPromise = connection.connect("wss://example.com/v1/stream", {} as MediaStream, 750);
        await vi.waitFor(() => expect(imageSpy).toHaveBeenCalled());

        internal.handleControlMessage({ type: "error", error: "server unavailable" });

        await expect(connectPromise).rejects.toThrow("server unavailable");
        expect(onError).toHaveBeenCalledTimes(1);

        joinSpy.mockRestore();
        imageSpy.mockRestore();
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });

  describe("queue handling", () => {
    it("waits in pending when bouncer reports queue position before room info", async () => {
      vi.useFakeTimers();
      const { LiveKitConnection } = await import("../src/realtime/livekit-connection.js");
      const states: ConnectionState[] = [];
      const stateDetails: Array<import("../src/realtime/types.js").ConnectionChangeDetails | undefined> = [];
      const queuePositions: Array<{ position: number; queueSize: number }> = [];
      const { sentMessages } = installFakeWebSocket((ws, message) => {
        if (message.type === "livekit_join") {
          setTimeout(() => ws.emitMessage({ type: "queue_position", position: 4, queue_size: 4 }), 0);
          setTimeout(
            () =>
              ws.emitMessage({
                type: "livekit_room_info",
                livekit_url: "wss://livekit.example.com",
                token: "token",
                room_name: "room",
              }),
            20_000,
          );
        }
      });

      try {
        const connection = new LiveKitConnection({
          onStateChange: (state, details) => {
            states.push(state);
            stateDetails.push(details);
          },
          onQueuePosition: (queuePosition) => queuePositions.push(queuePosition),
        });
        const internal = connection as unknown as {
          joinRoom: (info: unknown) => Promise<void>;
        };
        const joinSpy = vi.spyOn(internal, "joinRoom").mockResolvedValue(undefined);

        let rejected = false;
        const connectPromise = connection.connect("wss://example.com/v1/stream", null, 750).catch((error: unknown) => {
          rejected = true;
          throw error;
        });

        await vi.advanceTimersByTimeAsync(1);

        expect(sentMessages).toContainEqual({ type: "livekit_join" });
        expect(states).toContain("pending");
        expect(stateDetails[states.indexOf("pending")]).toEqual({
          queuePosition: { position: 4, queueSize: 4 },
        });
        expect(queuePositions).toEqual([{ position: 4, queueSize: 4 }]);

        await vi.advanceTimersByTimeAsync(15_001);

        expect(rejected).toBe(false);
        expect(joinSpy).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(5_000);
        await connectPromise;

        expect(joinSpy).toHaveBeenCalledWith({
          type: "livekit_room_info",
          livekit_url: "wss://livekit.example.com",
          token: "token",
          room_name: "room",
        });
        expect(connection.state).toBe("connected");

        joinSpy.mockRestore();
      } finally {
        vi.unstubAllGlobals();
        vi.useRealTimers();
      }
    });

    it("keeps waiting in pending when the queued socket stays open without room info", async () => {
      vi.useFakeTimers();
      const { LiveKitConnection } = await import("../src/realtime/livekit-connection.js");
      installFakeWebSocket((ws, message) => {
        if (message.type === "livekit_join") {
          setTimeout(() => ws.emitMessage({ type: "queue_position", position: 3, queue_size: 3 }), 0);
        }
      });

      try {
        const connection = new LiveKitConnection();
        const internal = connection as unknown as {
          joinRoom: (info: unknown) => Promise<void>;
        };
        const joinSpy = vi.spyOn(internal, "joinRoom").mockResolvedValue(undefined);
        let settled: "pending" | "rejected" = "pending";
        const connectPromise = connection.connect("wss://example.com/v1/stream", null, 750).catch((error: Error) => {
          settled = "rejected";
          return error;
        });

        await vi.advanceTimersByTimeAsync(1);
        expect(connection.state).toBe("pending");

        await vi.advanceTimersByTimeAsync(5 * 60_000);

        expect(settled).toBe("pending");
        expect(connection.state).toBe("pending");
        expect(joinSpy).not.toHaveBeenCalled();

        connection.cleanup();
        await connectPromise;
        joinSpy.mockRestore();
      } finally {
        vi.unstubAllGlobals();
        vi.useRealTimers();
      }
    });

    it("connects after repeated queue updates and a long queued wait", async () => {
      vi.useFakeTimers();
      const { LiveKitConnection } = await import("../src/realtime/livekit-connection.js");
      installFakeWebSocket((ws, message) => {
        if (message.type === "livekit_join") {
          setTimeout(() => ws.emitMessage({ type: "queue_position", position: 3, queue_size: 3 }), 0);
          setTimeout(() => ws.emitMessage({ type: "queue_position", position: 2, queue_size: 3 }), 50_000);
          setTimeout(
            () =>
              ws.emitMessage({
                type: "livekit_room_info",
                livekit_url: "wss://livekit.example.com",
                token: "token",
                room_name: "room",
              }),
            180_000,
          );
        }
      });

      try {
        const connection = new LiveKitConnection();
        const internal = connection as unknown as {
          joinRoom: (info: unknown) => Promise<void>;
        };
        const joinSpy = vi.spyOn(internal, "joinRoom").mockResolvedValue(undefined);
        let settled: "pending" | "resolved" = "pending";
        const connectPromise = connection.connect("wss://example.com/v1/stream", null, 750).catch((error: Error) => {
          throw error;
        });

        await vi.advanceTimersByTimeAsync(1);
        connectPromise.then(() => {
          settled = "resolved";
        });
        await vi.advanceTimersByTimeAsync(120_000);
        expect(settled).toBe("pending");

        await vi.advanceTimersByTimeAsync(59_999);
        await connectPromise;

        expect(settled).toBe("resolved");
        expect(joinSpy).toHaveBeenCalledWith({
          type: "livekit_room_info",
          livekit_url: "wss://livekit.example.com",
          token: "token",
          room_name: "room",
        });
        expect(connection.state).toBe("connected");

        joinSpy.mockRestore();
      } finally {
        vi.unstubAllGlobals();
        vi.useRealTimers();
      }
    });
  });

  describe("setImageBase64", () => {
    it("rejects immediately when WebSocket is not open", async () => {
      const { LiveKitConnection } = await import("../src/realtime/livekit-connection.js");
      const connection = new LiveKitConnection();

      await expect(connection.setImageBase64("base64data", { timeout: 5000 })).rejects.toThrow("WebSocket is not open");
    });

    it("rejects immediately with default timeout when WebSocket is not open", async () => {
      const { LiveKitConnection } = await import("../src/realtime/livekit-connection.js");
      const connection = new LiveKitConnection();

      await expect(connection.setImageBase64("base64data")).rejects.toThrow("WebSocket is not open");
    });

    it("uses custom timeout when send succeeds but ack is not received", async () => {
      vi.useFakeTimers();
      const { LiveKitConnection } = await import("../src/realtime/livekit-connection.js");
      const connection = new LiveKitConnection();
      const sendSpy = vi.spyOn(connection, "send").mockReturnValue(true);

      try {
        const customTimeout = 5000;
        let rejected = false;
        let rejectionError: Error | null = null;

        const promise = connection.setImageBase64("base64data", { timeout: customTimeout }).catch((err) => {
          rejected = true;
          rejectionError = err;
        });

        await vi.advanceTimersByTimeAsync(customTimeout - 1);
        expect(rejected).toBe(false);

        await vi.advanceTimersByTimeAsync(2);
        await promise;

        expect(rejected).toBe(true);
        expect(rejectionError?.message).toBe("Image send timed out");
      } finally {
        sendSpy.mockRestore();
        vi.useRealTimers();
      }
    });

    it("uses default timeout when send succeeds but ack is not received", async () => {
      vi.useFakeTimers();
      const { LiveKitConnection } = await import("../src/realtime/livekit-connection.js");
      const connection = new LiveKitConnection();
      const sendSpy = vi.spyOn(connection, "send").mockReturnValue(true);

      try {
        let rejected = false;
        let rejectionError: Error | null = null;

        const promise = connection.setImageBase64("base64data").catch((err) => {
          rejected = true;
          rejectionError = err;
        });

        await vi.advanceTimersByTimeAsync(29_999);
        expect(rejected).toBe(false);

        await vi.advanceTimersByTimeAsync(2);
        await promise;

        expect(rejected).toBe(true);
        expect(rejectionError?.message).toBe("Image send timed out");
      } finally {
        sendSpy.mockRestore();
        vi.useRealTimers();
      }
    });

    it("sends set_image with null image_data and null prompt for passthrough", async () => {
      vi.useFakeTimers();
      const { LiveKitConnection } = await import("../src/realtime/livekit-connection.js");
      const connection = new LiveKitConnection();
      const sendSpy = vi.spyOn(connection, "send").mockReturnValue(true);

      try {
        const promise = connection.setImageBase64(null, { prompt: null }).catch(() => {});

        expect(sendSpy).toHaveBeenCalledWith({
          type: "set_image",
          image_data: null,
          prompt: null,
        });

        await vi.advanceTimersByTimeAsync(30_001);
        await promise;
      } finally {
        sendSpy.mockRestore();
        vi.useRealTimers();
      }
    });
  });

  describe("publishLocalTracks", () => {
    it("uses LiveKit adaptive stream and dynacast room options", async () => {
      const { LIVEKIT_ROOM_OPTIONS } = await import("../src/realtime/livekit-connection.js");

      expect(LIVEKIT_ROOM_OPTIONS).toEqual({
        adaptiveStream: true,
        dynacast: true,
      });
    });

    it("publishes video with camera source, fixed h264 codec, and 2.5Mbps bitrate", async () => {
      const { LiveKitConnection } = await import("../src/realtime/livekit-connection.js");
      const publishTrack = vi.fn().mockResolvedValue({ trackSid: "video-sid", mimeType: "video/H264" });
      const videoTrack = {
        kind: "video",
        label: "camera",
        getSettings: () => ({ width: 1280, height: 720, frameRate: 22 }),
      } as unknown as MediaStreamTrack;
      const stream = { getTracks: () => [videoTrack] } as unknown as MediaStream;
      const connection = new LiveKitConnection();
      const internal = connection as unknown as {
        room: unknown;
        publishLocalTracks: (stream: MediaStream) => Promise<void>;
      };
      internal.room = { localParticipant: { publishTrack } };

      await internal.publishLocalTracks(stream);

      expect(publishTrack).toHaveBeenCalledTimes(1);
      expect(publishTrack).toHaveBeenCalledWith(videoTrack, {
        source: "camera",
        videoCodec: "h264",
        videoEncoding: { maxBitrate: 2_500_000 },
      });
      const options = publishTrack.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(options).not.toHaveProperty("simulcast");
      expect(options).not.toHaveProperty("scalabilityMode");
      expect(options).not.toHaveProperty("degradationPreference");
      expect(options.videoEncoding).not.toHaveProperty("maxFramerate");
    });

    it("publishes audio tracks without video encoding options", async () => {
      const { LiveKitConnection } = await import("../src/realtime/livekit-connection.js");
      const publishTrack = vi.fn().mockResolvedValue({ trackSid: "audio-sid", mimeType: "audio/opus" });
      const audioTrack = {
        kind: "audio",
        label: "microphone",
        getSettings: () => ({ sampleRate: 48_000 }),
      } as unknown as MediaStreamTrack;
      const stream = { getTracks: () => [audioTrack] } as unknown as MediaStream;
      const connection = new LiveKitConnection();
      const internal = connection as unknown as {
        room: unknown;
        publishLocalTracks: (stream: MediaStream) => Promise<void>;
      };
      internal.room = { localParticipant: { publishTrack } };

      await internal.publishLocalTracks(stream);

      expect(publishTrack).toHaveBeenCalledTimes(1);
      expect(publishTrack).toHaveBeenCalledWith(audioTrack);
    });

    it("publishes mixed streams once per track with video options only on video tracks", async () => {
      const { LiveKitConnection } = await import("../src/realtime/livekit-connection.js");
      const publishTrack = vi.fn().mockResolvedValue({ trackSid: "sid" });
      const videoTrack = { kind: "video", getSettings: () => ({}) } as unknown as MediaStreamTrack;
      const audioTrack = { kind: "audio", getSettings: () => ({}) } as unknown as MediaStreamTrack;
      const stream = { getTracks: () => [videoTrack, audioTrack] } as unknown as MediaStream;
      const connection = new LiveKitConnection();
      const internal = connection as unknown as {
        room: unknown;
        publishLocalTracks: (stream: MediaStream) => Promise<void>;
      };
      internal.room = { localParticipant: { publishTrack } };

      await internal.publishLocalTracks(stream);

      expect(publishTrack).toHaveBeenCalledTimes(2);
      expect(publishTrack).toHaveBeenNthCalledWith(
        1,
        videoTrack,
        expect.objectContaining({ source: "camera", videoCodec: "h264" }),
      );
      expect(publishTrack).toHaveBeenNthCalledWith(2, audioTrack);
    });
  });
});

describe("LiveKitManager", () => {
  it("treats generating as an established connection for reconnect decisions", async () => {
    const { LiveKitManager } = await import("../src/realtime/livekit-manager.js");
    const manager = new LiveKitManager({
      url: "wss://example.com",
      onRemoteStream: vi.fn(),
      onError: vi.fn(),
    });

    const internal = manager as unknown as {
      handleConnectionStateChange: (state: ConnectionState) => void;
      reconnect: () => Promise<void>;
    };

    const reconnectSpy = vi.spyOn(internal, "reconnect").mockResolvedValue(undefined);
    try {
      internal.handleConnectionStateChange("generating");
      internal.handleConnectionStateChange("disconnected");
      expect(reconnectSpy).toHaveBeenCalledTimes(1);
    } finally {
      reconnectSpy.mockRestore();
    }
  });

  it("subscribe mode allows reconnect with null localStream", async () => {
    const { LiveKitManager } = await import("../src/realtime/livekit-manager.js");

    const manager = new LiveKitManager({
      url: "wss://example.com",
      onRemoteStream: vi.fn(),
      onError: vi.fn(),
    });

    const internal = manager as unknown as {
      handleConnectionStateChange: (state: ConnectionState) => void;
      reconnect: () => Promise<void>;
      subscribeMode: boolean;
      managerState: ConnectionState;
      connectionStatus: { status: "connected" };
    };

    internal.subscribeMode = true;
    internal.managerState = "connected";
    internal.connectionStatus = { status: "connected" };

    const reconnectSpy = vi.spyOn(internal, "reconnect").mockResolvedValue(undefined);
    try {
      internal.handleConnectionStateChange("disconnected");
      expect(reconnectSpy).toHaveBeenCalledTimes(1);
    } finally {
      reconnectSpy.mockRestore();
    }
  });

  it("does not retry reconnect after the attempt reaches pending", async () => {
    vi.useFakeTimers();
    const { LiveKitConnection } = await import("../src/realtime/livekit-connection.js");
    const { LiveKitManager } = await import("../src/realtime/livekit-manager.js");
    const onError = vi.fn();

    const connectSpy = vi.spyOn(LiveKitConnection.prototype, "connect").mockImplementation(async function () {
      const connection = this as unknown as {
        callbacks: { onStateChange?: (state: ConnectionState) => void };
      };
      connection.callbacks.onStateChange?.("pending");
      throw new Error("WebSocket closed: 1006");
    });

    try {
      const manager = new LiveKitManager({
        url: "wss://example.com",
        onRemoteStream: vi.fn(),
        onError,
      });
      const internal = manager as unknown as {
        handleConnectionStateChange: (state: ConnectionState) => void;
        subscribeMode: boolean;
        managerState: ConnectionState;
        connectionStatus: { status: "connected" };
      };
      internal.subscribeMode = true;
      internal.managerState = "connected";
      internal.connectionStatus = { status: "connected" };

      internal.handleConnectionStateChange("disconnected");

      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1000);

      expect(connectSpy).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "WebSocket closed: 1006" }));
      expect(manager.getConnectionState()).toBe("disconnected");
    } finally {
      connectSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("does not retry initial connect after the attempt reaches pending", async () => {
    vi.useFakeTimers();
    const { LiveKitConnection } = await import("../src/realtime/livekit-connection.js");
    const { LiveKitManager } = await import("../src/realtime/livekit-manager.js");
    const stream = { getTracks: () => [] } as unknown as MediaStream;

    const connectSpy = vi.spyOn(LiveKitConnection.prototype, "connect").mockImplementation(async function () {
      const connection = this as unknown as {
        callbacks: { onStateChange?: (state: ConnectionState) => void };
      };
      connection.callbacks.onStateChange?.("pending");
      throw new Error("WebSocket closed: 1006");
    });

    try {
      const manager = new LiveKitManager({
        url: "wss://example.com",
        onRemoteStream: vi.fn(),
        onError: vi.fn(),
      });

      const connectPromise = manager.connect(stream).catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1000);

      expect(connectSpy).toHaveBeenCalledTimes(1);
      await expect(connectPromise).resolves.toMatchObject({ message: "WebSocket closed: 1006" });
    } finally {
      connectSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe("LiveKit realtime client integration", () => {
  it("publishes pending state and queue position through connect callbacks before connect resolves", async () => {
    const { createRealTimeClient } = await import("../src/realtime/client.js");
    const { LiveKitManager } = await import("../src/realtime/livekit-manager.js");
    let resolveConnect: (() => void) | undefined;

    const connectSpy = vi.spyOn(LiveKitManager.prototype, "connect").mockImplementation(async function () {
      const manager = this as unknown as {
        config: {
          onConnectionStateChange?: (
            state: ConnectionState,
            details?: import("../src/realtime/types.js").ConnectionChangeDetails,
          ) => void;
          onQueuePosition?: (queuePosition: { position: number; queueSize: number }) => void;
        };
        managerState: ConnectionState;
      };

      manager.managerState = "connecting";
      manager.config.onConnectionStateChange?.("connecting");
      manager.managerState = "pending";
      manager.config.onConnectionStateChange?.("pending", { queuePosition: { position: 2, queueSize: 5 } });
      manager.config.onQueuePosition?.({ position: 2, queueSize: 5 });

      await new Promise<void>((resolve) => {
        resolveConnect = resolve;
      });

      manager.managerState = "connected";
      manager.config.onConnectionStateChange?.("connected");
      return true;
    });
    const stateSpy = vi.spyOn(LiveKitManager.prototype, "getConnectionState").mockImplementation(function () {
      const manager = this as unknown as { managerState: ConnectionState };
      return manager.managerState ?? "connected";
    });
    const cleanupSpy = vi.spyOn(LiveKitManager.prototype, "cleanup").mockImplementation(() => {});

    try {
      const realtime = createRealTimeClient({ baseUrl: "wss://example.com", apiKey: "test-key" });
      const connectionStates: ConnectionState[] = [];
      const connectionDetails: Array<import("../src/realtime/types.js").ConnectionChangeDetails | undefined> = [];
      const queuePositions: Array<{ position: number; queueSize: number }> = [];

      const connectPromise = realtime.connect({} as MediaStream, {
        model: models.realtime("lucy-latest"),
        onRemoteStream: vi.fn(),
        onConnectionChange: (state, details) => {
          connectionStates.push(state);
          connectionDetails.push(details);
        },
        onQueuePosition: (queuePosition) => queuePositions.push(queuePosition),
      });

      await vi.waitFor(() => {
        expect(connectionStates).toEqual(["connecting", "pending"]);
        expect(connectionDetails[1]).toEqual({ queuePosition: { position: 2, queueSize: 5 } });
        expect(queuePositions).toEqual([{ position: 2, queueSize: 5 }]);
      });

      resolveConnect?.();
      const client = await connectPromise;
      const pendingEvents: Array<{ position: number; queueSize: number }> = [];
      client.on("pending", (queuePosition) => pendingEvents.push(queuePosition));

      expect(client.getConnectionState()).toBe("connected");
      expect(connectionStates).toEqual(["connecting", "pending", "connected"]);
      await vi.waitFor(() => {
        expect(pendingEvents).toEqual([{ position: 2, queueSize: 5 }]);
      });
    } finally {
      connectSpy.mockRestore();
      stateSpy.mockRestore();
      cleanupSpy.mockRestore();
    }
  });

  it("emits generationEnded with the server-provided reason", async () => {
    const { createRealTimeClient } = await import("../src/realtime/client.js");
    const { LiveKitManager } = await import("../src/realtime/livekit-manager.js");

    const generationEndedListeners = new Set<
      (msg: import("../src/realtime/types.js").GenerationEndedMessage) => void
    >();
    const websocketEmitter = {
      on: (event: string, listener: (msg: import("../src/realtime/types.js").GenerationEndedMessage) => void) => {
        if (event === "generationEnded") generationEndedListeners.add(listener);
      },
      off: (event: string, listener: (msg: import("../src/realtime/types.js").GenerationEndedMessage) => void) => {
        if (event === "generationEnded") generationEndedListeners.delete(listener);
      },
    };

    const connectSpy = vi.spyOn(LiveKitManager.prototype, "connect").mockImplementation(async function () {
      const manager = this as unknown as {
        config: { onConnectionStateChange?: (state: ConnectionState) => void };
        managerState: ConnectionState;
      };
      manager.managerState = "connected";
      manager.config.onConnectionStateChange?.("connected");
      return true;
    });
    const stateSpy = vi.spyOn(LiveKitManager.prototype, "getConnectionState").mockReturnValue("connected");
    const emitterSpy = vi
      .spyOn(LiveKitManager.prototype, "getWebsocketMessageEmitter")
      .mockReturnValue(websocketEmitter as never);
    const cleanupSpy = vi.spyOn(LiveKitManager.prototype, "cleanup").mockImplementation(() => {});

    try {
      const realtime = createRealTimeClient({ baseUrl: "wss://api3.decart.ai", apiKey: "test-key" });
      const client = await realtime.connect({} as MediaStream, {
        model: models.realtime("lucy-latest"),
        onRemoteStream: vi.fn(),
      });

      const endedEvents: Array<{ seconds: number; reason: string }> = [];
      client.on("generationEnded", (event) => endedEvents.push(event));

      for (const listener of generationEndedListeners) {
        listener({
          type: "generation_ended",
          seconds: 42,
          reason: "insufficient credits",
        });
      }

      await vi.waitFor(() => {
        expect(endedEvents).toEqual([{ seconds: 42, reason: "insufficient credits" }]);
      });
    } finally {
      connectSpy.mockRestore();
      stateSpy.mockRestore();
      emitterSpy.mockRestore();
      cleanupSpy.mockRestore();
    }
  });

  it("replays connection events emitted during connect before returning client", async () => {
    const { createRealTimeClient } = await import("../src/realtime/client.js");
    const { LiveKitManager } = await import("../src/realtime/livekit-manager.js");

    const promptAckListeners = new Set<(msg: import("../src/realtime/types.js").PromptAckMessage) => void>();
    const websocketEmitter = {
      on: (event: string, listener: (msg: import("../src/realtime/types.js").PromptAckMessage) => void) => {
        if (event === "promptAck") promptAckListeners.add(listener);
      },
      off: (event: string, listener: (msg: import("../src/realtime/types.js").PromptAckMessage) => void) => {
        if (event === "promptAck") promptAckListeners.delete(listener);
      },
    };

    const connectSpy = vi.spyOn(LiveKitManager.prototype, "connect").mockImplementation(async function () {
      const manager = this as unknown as {
        config: {
          onConnectionStateChange?: (state: ConnectionState) => void;
          initialPrompt?: { text: string; enhance?: boolean };
        };
        managerState: ConnectionState;
      };
      manager.managerState = "connected";
      manager.config.onConnectionStateChange?.("connected");

      if (manager.config.initialPrompt) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        manager.managerState = "generating";
        manager.config.onConnectionStateChange?.("generating");
      }

      return true;
    });
    const stateSpy = vi.spyOn(LiveKitManager.prototype, "getConnectionState").mockImplementation(function () {
      const manager = this as unknown as { managerState: ConnectionState };
      return manager.managerState ?? "connected";
    });
    const emitterSpy = vi
      .spyOn(LiveKitManager.prototype, "getWebsocketMessageEmitter")
      .mockReturnValue(websocketEmitter as never);
    const sendSpy = vi.spyOn(LiveKitManager.prototype, "sendMessage").mockImplementation(function (message) {
      if (message.type === "prompt") {
        setTimeout(() => {
          const manager = this as unknown as {
            config: { onConnectionStateChange?: (state: ConnectionState) => void };
            managerState: ConnectionState;
          };
          manager.managerState = "generating";
          manager.config.onConnectionStateChange?.("generating");
          for (const listener of promptAckListeners) {
            listener({
              type: "prompt_ack",
              prompt: message.prompt,
              success: true,
              error: null,
            });
          }
        }, 0);
      }
      return true;
    });
    const cleanupSpy = vi.spyOn(LiveKitManager.prototype, "cleanup").mockImplementation(() => {});

    try {
      const realtime = createRealTimeClient({ baseUrl: "wss://example.com", apiKey: "test-key" });
      const client = await realtime.connect({} as MediaStream, {
        model: models.realtime("lucy-latest"),
        onRemoteStream: vi.fn(),
        initialState: {
          prompt: {
            text: "test",
          },
        },
      });

      const states: ConnectionState[] = [];
      client.on("connectionChange", (state) => states.push(state));

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(states).toEqual(["connected", "generating"]);
    } finally {
      connectSpy.mockRestore();
      stateSpy.mockRestore();
      emitterSpy.mockRestore();
      sendSpy.mockRestore();
      cleanupSpy.mockRestore();
    }
  });

  it("passes api key, model, and custom query params into the LiveKit manager URL", async () => {
    const { createRealTimeClient } = await import("../src/realtime/client.js");
    const { LiveKitManager } = await import("../src/realtime/livekit-manager.js");
    let managerUrl: string | null = null;

    const connectSpy = vi.spyOn(LiveKitManager.prototype, "connect").mockImplementation(async function () {
      const mgr = this as unknown as {
        config: { url: string; onConnectionStateChange?: (state: ConnectionState) => void };
        managerState: ConnectionState;
      };
      managerUrl = mgr.config.url;
      mgr.managerState = "connected";
      mgr.config.onConnectionStateChange?.("connected");
      return true;
    });
    const stateSpy = vi.spyOn(LiveKitManager.prototype, "getConnectionState").mockReturnValue("connected");
    const cleanupSpy = vi.spyOn(LiveKitManager.prototype, "cleanup").mockImplementation(() => {});

    try {
      const realtime = createRealTimeClient({ baseUrl: "wss://api3.decart.ai", apiKey: "test-key" });
      const client = await realtime.connect({} as MediaStream, {
        model: models.realtime("lucy-latest"),
        queryParams: { region: "us-west", queue: "true" },
        onRemoteStream: vi.fn(),
      });

      expect(managerUrl).toBe(
        "wss://api3.decart.ai/v1/stream?region=us-west&queue=true&api_key=test-key&model=lucy-latest",
      );

      client.disconnect();
    } finally {
      connectSpy.mockRestore();
      stateSpy.mockRestore();
      cleanupSpy.mockRestore();
    }
  });

  it("session_id message populates subscribeToken on producer client", async () => {
    const { createRealTimeClient } = await import("../src/realtime/client.js");
    const { LiveKitManager } = await import("../src/realtime/livekit-manager.js");
    const { decodeSubscribeToken } = await import("../src/realtime/subscribe-client.js");

    const sessionIdListeners = new Set<(msg: import("../src/realtime/types.js").SessionIdMessage) => void>();
    const websocketEmitter = {
      on: (event: string, listener: (msg: import("../src/realtime/types.js").SessionIdMessage) => void) => {
        if (event === "sessionId") sessionIdListeners.add(listener);
      },
      off: (event: string, listener: (msg: import("../src/realtime/types.js").SessionIdMessage) => void) => {
        if (event === "sessionId") sessionIdListeners.delete(listener);
      },
    };

    const connectSpy = vi.spyOn(LiveKitManager.prototype, "connect").mockImplementation(async function () {
      const mgr = this as unknown as {
        config: { onConnectionStateChange?: (state: ConnectionState) => void };
        managerState: ConnectionState;
      };
      mgr.managerState = "connected";
      mgr.config.onConnectionStateChange?.("connected");
      return true;
    });
    const stateSpy = vi.spyOn(LiveKitManager.prototype, "getConnectionState").mockReturnValue("connected");
    const emitterSpy = vi
      .spyOn(LiveKitManager.prototype, "getWebsocketMessageEmitter")
      .mockReturnValue(websocketEmitter as never);
    const sendSpy = vi.spyOn(LiveKitManager.prototype, "sendMessage").mockReturnValue(true);
    const cleanupSpy = vi.spyOn(LiveKitManager.prototype, "cleanup").mockImplementation(() => {});

    try {
      const realtime = createRealTimeClient({ baseUrl: "wss://api3.decart.ai", apiKey: "test-key" });
      const client = await realtime.connect({} as MediaStream, {
        model: models.realtime("lucy-latest"),
        onRemoteStream: vi.fn(),
      });

      expect(client.subscribeToken).toBeNull();

      for (const listener of sessionIdListeners) {
        listener({
          type: "session_id",
          session_id: "sess-abc",
          server_ip: "10.0.0.5",
          server_port: 9090,
        });
      }

      const token = client.subscribeToken;
      expect(token).not.toBeNull();
      // biome-ignore lint/style/noNonNullAssertion: guarded by assertion above
      const decoded = decodeSubscribeToken(token!);
      expect(decoded.sid).toBe("sess-abc");
      expect(decoded.ip).toBe("10.0.0.5");
      expect(decoded.port).toBe(9090);
    } finally {
      connectSpy.mockRestore();
      stateSpy.mockRestore();
      emitterSpy.mockRestore();
      sendSpy.mockRestore();
      cleanupSpy.mockRestore();
    }
  });

  it("buffers pre-session telemetry diagnostics and flushes them after session_id", async () => {
    const { createRealTimeClient } = await import("../src/realtime/client.js");
    const { LiveKitManager } = await import("../src/realtime/livekit-manager.js");

    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const sessionIdListeners = new Set<(msg: import("../src/realtime/types.js").SessionIdMessage) => void>();
    const websocketEmitter = {
      on: (event: string, listener: (msg: import("../src/realtime/types.js").SessionIdMessage) => void) => {
        if (event === "sessionId") sessionIdListeners.add(listener);
      },
      off: (event: string, listener: (msg: import("../src/realtime/types.js").SessionIdMessage) => void) => {
        if (event === "sessionId") sessionIdListeners.delete(listener);
      },
    };

    const connectSpy = vi.spyOn(LiveKitManager.prototype, "connect").mockImplementation(async function () {
      const mgr = this as unknown as {
        config: {
          onConnectionStateChange?: (state: ConnectionState) => void;
          onDiagnostic?: (name: string, data: unknown) => void;
        };
        managerState: ConnectionState;
      };

      mgr.config.onDiagnostic?.("phaseTiming", {
        phase: "websocket",
        durationMs: 12,
        success: true,
      });

      mgr.managerState = "connected";
      mgr.config.onConnectionStateChange?.("connected");
      return true;
    });
    const stateSpy = vi.spyOn(LiveKitManager.prototype, "getConnectionState").mockReturnValue("connected");
    const emitterSpy = vi
      .spyOn(LiveKitManager.prototype, "getWebsocketMessageEmitter")
      .mockReturnValue(websocketEmitter as never);
    const cleanupSpy = vi.spyOn(LiveKitManager.prototype, "cleanup").mockImplementation(() => {});

    try {
      const realtime = createRealTimeClient({
        baseUrl: "wss://api3.decart.ai",
        apiKey: "test-key",
        logger: { debug() {}, info() {}, warn() {}, error() {} },
        telemetryEnabled: true,
      });
      const client = await realtime.connect({} as MediaStream, {
        model: models.realtime("lucy-latest"),
        onRemoteStream: vi.fn(),
      });

      expect(fetchMock).not.toHaveBeenCalled();

      for (const listener of sessionIdListeners) {
        listener({
          type: "session_id",
          session_id: "sess-telemetry",
          server_ip: "10.0.0.5",
          server_port: 9090,
        });
      }

      client.disconnect();

      await vi.waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });

      const [, options] = fetchMock.mock.calls[0];
      const body = JSON.parse(options.body);
      expect(body.diagnostics).toHaveLength(1);
      expect(body.diagnostics[0].name).toBe("phaseTiming");
      expect(body.diagnostics[0].data.phase).toBe("websocket");
    } finally {
      connectSpy.mockRestore();
      stateSpy.mockRestore();
      emitterSpy.mockRestore();
      cleanupSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("stops previous telemetry reporter when session_id changes", async () => {
    const { createRealTimeClient } = await import("../src/realtime/client.js");
    const { LiveKitManager } = await import("../src/realtime/livekit-manager.js");

    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");

    const sessionIdListeners = new Set<(msg: import("../src/realtime/types.js").SessionIdMessage) => void>();
    const websocketEmitter = {
      on: (event: string, listener: (msg: import("../src/realtime/types.js").SessionIdMessage) => void) => {
        if (event === "sessionId") sessionIdListeners.add(listener);
      },
      off: (event: string, listener: (msg: import("../src/realtime/types.js").SessionIdMessage) => void) => {
        if (event === "sessionId") sessionIdListeners.delete(listener);
      },
    };

    const connectSpy = vi.spyOn(LiveKitManager.prototype, "connect").mockImplementation(async function () {
      const mgr = this as unknown as {
        config: { onConnectionStateChange?: (state: ConnectionState) => void };
        managerState: ConnectionState;
      };
      mgr.managerState = "connected";
      mgr.config.onConnectionStateChange?.("connected");
      return true;
    });
    const stateSpy = vi.spyOn(LiveKitManager.prototype, "getConnectionState").mockReturnValue("connected");
    const emitterSpy = vi
      .spyOn(LiveKitManager.prototype, "getWebsocketMessageEmitter")
      .mockReturnValue(websocketEmitter as never);
    const cleanupSpy = vi.spyOn(LiveKitManager.prototype, "cleanup").mockImplementation(() => {});

    try {
      const realtime = createRealTimeClient({
        baseUrl: "wss://api3.decart.ai",
        apiKey: "test-key",
        logger: { debug() {}, info() {}, warn() {}, error() {} },
        telemetryEnabled: true,
      });
      const client = await realtime.connect({} as MediaStream, {
        model: models.realtime("lucy-latest"),
        onRemoteStream: vi.fn(),
      });

      for (const listener of sessionIdListeners) {
        listener({
          type: "session_id",
          session_id: "sess-1",
          server_ip: "10.0.0.5",
          server_port: 9090,
        });
      }
      for (const listener of sessionIdListeners) {
        listener({
          type: "session_id",
          session_id: "sess-2",
          server_ip: "10.0.0.6",
          server_port: 9091,
        });
      }

      client.disconnect();

      expect(setIntervalSpy).toHaveBeenCalledTimes(2);
      expect(clearIntervalSpy).toHaveBeenCalledTimes(2);
    } finally {
      connectSpy.mockRestore();
      stateSpy.mockRestore();
      emitterSpy.mockRestore();
      cleanupSpy.mockRestore();
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("restarts stats collection when stats source changes after reconnect", async () => {
    const { createRealTimeClient } = await import("../src/realtime/client.js");
    const { LiveKitManager } = await import("../src/realtime/livekit-manager.js");
    const { WebRTCStatsCollector } = await import("../src/realtime/webrtc-stats.js");

    const firstStatsSource = { getStats: vi.fn() };
    const secondStatsSource = { getStats: vi.fn() };
    let currentStatsSource: typeof firstStatsSource = firstStatsSource;
    let onConnectionStateChange: ((state: ConnectionState) => void) | undefined;

    const startSpy = vi.spyOn(WebRTCStatsCollector.prototype, "start").mockImplementation(() => {});
    const stopSpy = vi.spyOn(WebRTCStatsCollector.prototype, "stop").mockImplementation(() => {});

    const connectSpy = vi.spyOn(LiveKitManager.prototype, "connect").mockImplementation(async function () {
      const mgr = this as unknown as {
        config: { onConnectionStateChange?: (state: ConnectionState) => void };
        managerState: ConnectionState;
      };
      onConnectionStateChange = mgr.config.onConnectionStateChange;
      mgr.managerState = "connected";
      mgr.config.onConnectionStateChange?.("connected");
      return true;
    });
    const stateSpy = vi.spyOn(LiveKitManager.prototype, "getConnectionState").mockReturnValue("connected");
    const statsProviderSpy = vi
      .spyOn(LiveKitManager.prototype, "getStatsProvider")
      .mockImplementation(() => currentStatsSource);
    const cleanupSpy = vi.spyOn(LiveKitManager.prototype, "cleanup").mockImplementation(() => {});

    try {
      const realtime = createRealTimeClient({
        baseUrl: "wss://api3.decart.ai",
        apiKey: "test-key",
        logger: { debug() {}, info() {}, warn() {}, error() {} },
        telemetryEnabled: true,
      });
      const client = await realtime.connect({} as MediaStream, {
        model: models.realtime("lucy-latest"),
        onRemoteStream: vi.fn(),
      });

      expect(startSpy).toHaveBeenCalledTimes(1);
      expect(startSpy.mock.calls[0][0]).toBe(firstStatsSource);

      currentStatsSource = secondStatsSource;
      onConnectionStateChange?.("connected");

      expect(startSpy).toHaveBeenCalledTimes(2);
      expect(startSpy.mock.calls[1][0]).toBe(secondStatsSource);

      client.disconnect();
      expect(stopSpy).toHaveBeenCalled();
    } finally {
      startSpy.mockRestore();
      stopSpy.mockRestore();
      connectSpy.mockRestore();
      stateSpy.mockRestore();
      statsProviderSpy.mockRestore();
      cleanupSpy.mockRestore();
    }
  });

  it("subscribe client buffers events until returned", async () => {
    const { encodeSubscribeToken } = await import("../src/realtime/subscribe-client.js");
    const { createRealTimeClient } = await import("../src/realtime/client.js");
    const { LiveKitManager } = await import("../src/realtime/livekit-manager.js");

    const connectSpy = vi.spyOn(LiveKitManager.prototype, "connect").mockImplementation(async function () {
      const mgr = this as unknown as {
        config: { onConnectionStateChange?: (state: ConnectionState) => void };
        managerState: ConnectionState;
      };
      mgr.managerState = "connected";
      mgr.config.onConnectionStateChange?.("connected");
      return true;
    });
    const stateSpy = vi.spyOn(LiveKitManager.prototype, "getConnectionState").mockReturnValue("connected");
    const cleanupSpy = vi.spyOn(LiveKitManager.prototype, "cleanup").mockImplementation(() => {});

    try {
      const token = encodeSubscribeToken("sess-123", "10.0.0.1", 8080);
      const realtime = createRealTimeClient({ baseUrl: "wss://api3.decart.ai", apiKey: "sub-key" });
      const client = await realtime.subscribe({
        token,
        onRemoteStream: vi.fn(),
      });

      const states: ConnectionState[] = [];
      client.on("connectionChange", (state) => states.push(state));

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(states).toEqual(["connected"]);

      client.disconnect();
    } finally {
      connectSpy.mockRestore();
      stateSpy.mockRestore();
      cleanupSpy.mockRestore();
    }
  });
});
