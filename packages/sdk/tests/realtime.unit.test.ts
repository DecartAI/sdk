import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDecartClient, models } from "../src/index.js";
import { REALTIME_CONFIG } from "../src/realtime/config-realtime.js";
import type { ServerError } from "../src/realtime/types.js";

const liveKitMock = vi.hoisted(() => {
  const roomInstances: MockRoom[] = [];

  const RoomEvent = {
    TrackSubscribed: "trackSubscribed",
    Disconnected: "disconnected",
    ConnectionStateChanged: "connectionStateChanged",
  } as const;
  const Track = {
    Kind: { Video: "video", Audio: "audio" },
    Source: { Camera: "camera" },
  } as const;
  const TrackEvent = { VideoPlaybackStarted: "videoPlaybackStarted" } as const;
  const ConnectionState = {
    Connecting: "connecting",
    Connected: "connected",
    Reconnecting: "reconnecting",
    SignalReconnecting: "signalReconnecting",
    Disconnected: "disconnected",
  } as const;

  class MockRoom {
    handlers = new Map<string, Array<(...args: unknown[]) => void>>();
    state = ConnectionState.Connected;
    localParticipant = {
      publishTrack: vi.fn().mockResolvedValue(undefined),
    };
    connect = vi.fn().mockResolvedValue(undefined);
    disconnect = vi.fn().mockResolvedValue(undefined);

    constructor() {
      roomInstances.push(this);
    }

    on(event: string, handler: (...args: unknown[]) => void): this {
      const handlers = this.handlers.get(event) ?? [];
      handlers.push(handler);
      this.handlers.set(event, handlers);
      return this;
    }

    emit(event: string, ...args: unknown[]): void {
      for (const handler of this.handlers.get(event) ?? []) handler(...args);
    }
  }

  return { roomInstances, RoomEvent, Track, TrackEvent, ConnectionState, MockRoom };
});

vi.mock("livekit-client", () => ({
  Room: liveKitMock.MockRoom,
  RoomEvent: liveKitMock.RoomEvent,
  Track: liveKitMock.Track,
  TrackEvent: liveKitMock.TrackEvent,
  ConnectionState: liveKitMock.ConnectionState,
}));

class FakeMediaStream {
  private tracks: unknown[];

  constructor(tracks: unknown[] = []) {
    this.tracks = [...tracks];
  }

  getTracks(): unknown[] {
    return this.tracks;
  }

  getVideoTracks(): unknown[] {
    return this.tracks.filter((track) => (track as { kind?: string }).kind === "video");
  }

  addTrack(track: unknown): void {
    this.tracks.push(track);
  }
}

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

type FakeWebSocketMessageEvent = {
  data: string;
};

type FakeWebSocketCloseEvent = {
  code: number;
  reason: string;
};

describe("top-level realtime client", () => {
  it("exposes warmup through createDecartClient", () => {
    const client = createDecartClient({
      apiKey: "test",
      realtimeBaseUrl: "wss://realtime.example.com",
    });

    expect(typeof client.realtime.warmup).toBe("function");
  });
});

describe("Lucy 2.1 realtime", () => {
  describe("Model Definition", () => {
    it("has correct model name", () => {
      const lucyModel = models.realtime("lucy-2.1");
      expect(lucyModel.name).toBe("lucy-2.1");
    });

    it("has correct URL path", () => {
      const lucyModel = models.realtime("lucy-2.1");
      expect(lucyModel.urlPath).toBe("/v1/stream");
    });

    it("has expected dimensions", () => {
      const lucyModel = models.realtime("lucy-2.1");
      expect(lucyModel.width).toBe(1088);
      expect(lucyModel.height).toBe(624);
    });

    it("has correct fps", () => {
      const lucyModel = models.realtime("lucy-2.1");
      expect(lucyModel.fps).toEqual({ ideal: 30, max: 30 });
    });

    it("is recognized as a realtime model", () => {
      expect(models.realtime("lucy-2.1")).toBeDefined();
    });
  });
});

describe("Realtime Image Message Types", () => {
  it("SetImageMessage has correct structure", () => {
    const message: import("../src/realtime/types").SetImageMessage = {
      type: "set_image",
      image_data: "base64encodeddata",
    };

    expect(message.type).toBe("set_image");
    expect(message.image_data).toBe("base64encodeddata");
  });

  it("SetImageAckMessage has correct structure", () => {
    const successMessage: import("../src/realtime/types").SetImageAckMessage = {
      type: "set_image_ack",
      success: true,
      error: null,
    };

    expect(successMessage.type).toBe("set_image_ack");
    expect(successMessage.success).toBe(true);
    expect(successMessage.error).toBeNull();

    const failureMessage: import("../src/realtime/types").SetImageAckMessage = {
      type: "set_image_ack",
      success: false,
      error: "invalid image",
    };

    expect(failureMessage.type).toBe("set_image_ack");
    expect(failureMessage.success).toBe(false);
    expect(failureMessage.error).toBe("invalid image");
  });
});

describe("set()", () => {
  let mockSession: {
    sendPrompt: ReturnType<typeof vi.fn>;
    setImage: ReturnType<typeof vi.fn>;
  };
  let mockImageToBase64: ReturnType<typeof vi.fn>;
  let methods: ReturnType<typeof import("../src/realtime/methods.js").realtimeMethods>;

  beforeEach(async () => {
    const { realtimeMethods } = await import("../src/realtime/methods.js");
    mockSession = {
      sendPrompt: vi.fn().mockResolvedValue(undefined),
      setImage: vi.fn().mockResolvedValue(undefined),
    };
    mockImageToBase64 = vi.fn().mockResolvedValue("base64data");
    // biome-ignore lint/suspicious/noExplicitAny: testing with mock
    methods = realtimeMethods(mockSession as any, mockImageToBase64);
  });

  it("rejects when neither prompt nor image is provided", async () => {
    await expect(methods.set({})).rejects.toThrow("At least one of 'prompt' or 'image' must be provided");
  });

  it("rejects when prompt is empty string", async () => {
    await expect(methods.set({ prompt: "" })).rejects.toThrow();
  });

  it("setPrompt delegates to session with parsed inputs", async () => {
    await methods.setPrompt("a cat", { enhance: false });
    expect(mockSession.sendPrompt).toHaveBeenCalledWith("a cat", {
      enhance: false,
      timeout: REALTIME_CONFIG.methods.promptTimeoutMs,
    });
  });

  it("setPrompt defaults enhance to true", async () => {
    await methods.setPrompt("a cat");
    expect(mockSession.sendPrompt).toHaveBeenCalledWith("a cat", {
      enhance: true,
      timeout: REALTIME_CONFIG.methods.promptTimeoutMs,
    });
  });

  it("setPrompt propagates session rejections", async () => {
    mockSession.sendPrompt.mockRejectedValue(new Error("invalid prompt"));
    await expect(methods.setPrompt("a cat")).rejects.toThrow("invalid prompt");
  });

  it("sends only prompt when no image provided", async () => {
    await methods.set({ prompt: "a cat" });
    expect(mockSession.setImage).toHaveBeenCalledWith(
      { kind: "data", data: null },
      {
        prompt: "a cat",
        enhance: true,
        timeout: REALTIME_CONFIG.methods.updateTimeoutMs,
      },
    );
  });

  it("sends prompt with enhance flag", async () => {
    await methods.set({ prompt: "a cat", enhance: true });
    expect(mockSession.setImage).toHaveBeenCalledWith(
      { kind: "data", data: null },
      {
        prompt: "a cat",
        enhance: true,
        timeout: REALTIME_CONFIG.methods.updateTimeoutMs,
      },
    );
  });

  it("sends only image when no prompt provided", async () => {
    mockImageToBase64.mockResolvedValue("convertedbase64");
    await methods.set({ image: "rawbase64data" });

    expect(mockImageToBase64).toHaveBeenCalledWith("rawbase64data");
    expect(mockSession.setImage).toHaveBeenCalledWith(
      { kind: "data", data: "convertedbase64" },
      {
        prompt: undefined,
        enhance: true,
        timeout: REALTIME_CONFIG.methods.updateTimeoutMs,
      },
    );
  });

  it("sends prompt and image together", async () => {
    mockImageToBase64.mockResolvedValue("convertedbase64");
    await methods.set({ prompt: "a cat", enhance: false, image: "rawbase64" });

    expect(mockSession.setImage).toHaveBeenCalledWith(
      { kind: "data", data: "convertedbase64" },
      {
        prompt: "a cat",
        enhance: false,
        timeout: REALTIME_CONFIG.methods.updateTimeoutMs,
      },
    );
  });

  it("converts Blob image to base64", async () => {
    mockImageToBase64.mockResolvedValue("blobbase64");
    const testBlob = new Blob(["test-image"], { type: "image/png" });
    await methods.set({ image: testBlob });

    expect(mockImageToBase64).toHaveBeenCalledWith(testBlob);
    expect(mockSession.setImage).toHaveBeenCalledWith(
      { kind: "data", data: "blobbase64" },
      {
        prompt: undefined,
        enhance: true,
        timeout: REALTIME_CONFIG.methods.updateTimeoutMs,
      },
    );
  });

  it("treats a 'file_*' string as a server-side reference id, no base64 encoding", async () => {
    await methods.set({ image: "file_abc123", prompt: "make it cinematic" });

    expect(mockImageToBase64).not.toHaveBeenCalled();
    expect(mockSession.setImage).toHaveBeenCalledWith(
      { kind: "ref", ref: "file_abc123" },
      {
        prompt: "make it cinematic",
        enhance: true,
        timeout: REALTIME_CONFIG.methods.updateTimeoutMs,
      },
    );
  });

  it("still treats non-'file_' strings as base64/URL inputs (encoded via imageToBase64)", async () => {
    mockImageToBase64.mockResolvedValue("convertedbase64");
    await methods.set({ image: "rawbase64data" });

    expect(mockImageToBase64).toHaveBeenCalledWith("rawbase64data");
    expect(mockSession.setImage).toHaveBeenCalledWith(
      { kind: "data", data: "convertedbase64" },
      expect.objectContaining({ timeout: REALTIME_CONFIG.methods.updateTimeoutMs }),
    );
  });
});

describe("Subscribe Token", () => {
  it("encodes and decodes a subscribe token round-trip", async () => {
    const { encodeSubscribeToken } = await import("../src/realtime/stream-session.js");
    const { decodeSubscribeToken } = await import("../src/realtime/subscribe-client.js");
    const token = encodeSubscribeToken("session-abc123");
    const decoded = decodeSubscribeToken(token);

    expect(decoded).toEqual({ room_name: "session-abc123" });
    expect(decoded).not.toHaveProperty("sid");
    expect(decoded).not.toHaveProperty("ip");
    expect(decoded).not.toHaveProperty("port");
  });

  it("throws on invalid base64 token", async () => {
    const { decodeSubscribeToken } = await import("../src/realtime/subscribe-client.js");
    expect(() => decodeSubscribeToken("not-valid-base64!!!")).toThrow("Invalid subscribe token");
  });

  it("throws on valid base64 but invalid payload", async () => {
    const { decodeSubscribeToken } = await import("../src/realtime/subscribe-client.js");
    const token = btoa(JSON.stringify({ sid: "s" }));
    expect(() => decodeSubscribeToken(token)).toThrow("Invalid subscribe token");
  });
});

describe("realtime.connect options", () => {
  class FakeWebSocket {
    static OPEN = 1;
    static instances: FakeWebSocket[] = [];

    readyState = FakeWebSocket.OPEN;
    onopen: (() => void) | null = null;
    onmessage: ((event: FakeWebSocketMessageEvent) => void) | null = null;
    onclose: ((event: FakeWebSocketCloseEvent) => void) | null = null;
    sentMessages: unknown[] = [];

    constructor(readonly url: string) {
      FakeWebSocket.instances.push(this);
      setTimeout(() => this.onopen?.(), 0);
    }

    send(data: string): void {
      const message = JSON.parse(data);
      this.sentMessages.push(message);
      if (message.type === "livekit_join") {
        setTimeout(() => {
          this.onmessage?.({
            data: JSON.stringify({
              type: "livekit_room_info",
              livekit_url: "wss://livekit.example.test",
              token: "token",
              room_name: "room",
              session_id: "session-room",
            }),
          });
        }, 0);
      }
    }
    close(): void {
      this.onclose?.({ code: 1000, reason: "closed" });
    }
  }

  beforeEach(() => {
    FakeWebSocket.instances = [];
    liveKitMock.roomInstances.length = 0;
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("MediaStream", FakeMediaStream);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("adds resolution to the realtime URL when provided", async () => {
    const { createRealTimeClient } = await import("../src/realtime/client.js");
    const client = createRealTimeClient({
      baseUrl: "wss://api3.decart.ai",
      apiKey: "test-key",
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      telemetryEnabled: false,
    });

    const realtimeClient = await client.connect(null, {
      model: models.realtime("lucy-2.1"),
      resolution: "1080p",
      onRemoteStream: vi.fn(),
    });

    const url = new URL(FakeWebSocket.instances[0].url);
    expect(url.searchParams.get("resolution")).toBe("1080p");
    realtimeClient.disconnect();
  });

  it("rejects unsupported realtime resolutions", async () => {
    const { createRealTimeClient } = await import("../src/realtime/client.js");
    const client = createRealTimeClient({
      baseUrl: "wss://api3.decart.ai",
      apiKey: "test-key",
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      telemetryEnabled: false,
    });

    await expect(
      client.connect(null, {
        model: models.realtime("lucy-2.1"),
        resolution: "480p" as never,
        onRemoteStream: vi.fn(),
      }),
    ).rejects.toThrow();
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  const createLocalStream = () =>
    new MediaStream([
      { id: "local-video", kind: "video" },
      { id: "local-audio", kind: "audio" },
    ] as unknown[]) as MediaStream;

  it("warmup adds livekit_warmup and connects LiveKit without publishing tracks", async () => {
    const { createRealTimeClient } = await import("../src/realtime/client.js");
    const client = createRealTimeClient({
      baseUrl: "wss://api3.decart.ai",
      apiKey: "test-key",
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      telemetryEnabled: false,
    });

    const warmupClient = await client.warmup({
      model: models.realtime("lucy-2.1"),
      onRemoteStream: vi.fn(),
    });

    const url = new URL(FakeWebSocket.instances[0].url);
    expect(url.searchParams.get("livekit_warmup")).toBe("1");
    const room = liveKitMock.roomInstances[0] as InstanceType<typeof liveKitMock.MockRoom>;
    expect(room.connect).toHaveBeenCalledWith("wss://livekit.example.test", "token");
    expect(room.localParticipant.publishTrack).not.toHaveBeenCalled();
    warmupClient.disconnect();
  });

  it("warmup does not wait for initial prompt ack before becoming ready", async () => {
    const { createRealTimeClient } = await import("../src/realtime/client.js");
    const client = createRealTimeClient({
      baseUrl: "wss://api3.decart.ai",
      apiKey: "test-key",
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      telemetryEnabled: false,
    });

    const warmupClient = await Promise.race([
      client.warmup({
        model: models.realtime("lucy-2.1"),
        onRemoteStream: vi.fn(),
        initialState: {
          prompt: { text: "test prompt" },
        },
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("warmup timed out")), 100)),
    ]);

    expect(FakeWebSocket.instances[0].sentMessages).toContainEqual({ type: "livekit_join" });
    expect(FakeWebSocket.instances[0].sentMessages).toContainEqual({
      type: "prompt",
      prompt: "test prompt",
      enhance_prompt: true,
    });
    warmupClient.disconnect();
  });

  it("warmup start publishes local video and audio tracks once", async () => {
    const { createRealTimeClient } = await import("../src/realtime/client.js");
    const client = createRealTimeClient({
      baseUrl: "wss://api3.decart.ai",
      apiKey: "test-key",
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      telemetryEnabled: false,
    });

    const warmupClient = await client.warmup({
      model: models.realtime("lucy-2.1"),
      preferredVideoCodec: "h264",
      onRemoteStream: vi.fn(),
    });
    const localStream = createLocalStream();
    const realtimeClient = await warmupClient.start(localStream);

    const room = liveKitMock.roomInstances[0] as InstanceType<typeof liveKitMock.MockRoom>;
    expect(room.localParticipant.publishTrack).toHaveBeenCalledTimes(2);
    expect(room.localParticipant.publishTrack).toHaveBeenNthCalledWith(
      1,
      localStream.getTracks()[0],
      expect.objectContaining({ videoCodec: "h264", source: liveKitMock.Track.Source.Camera }),
    );
    expect(room.localParticipant.publishTrack).toHaveBeenNthCalledWith(2, localStream.getTracks()[1]);
    await expect(warmupClient.start(localStream)).rejects.toThrow("already been started");
    realtimeClient.disconnect();
  });

  it("warmup disconnect before start closes the room and websocket", async () => {
    const { createRealTimeClient } = await import("../src/realtime/client.js");
    const client = createRealTimeClient({
      baseUrl: "wss://api3.decart.ai",
      apiKey: "test-key",
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      telemetryEnabled: false,
    });

    const warmupClient = await client.warmup({
      model: models.realtime("lucy-2.1"),
      onRemoteStream: vi.fn(),
    });
    warmupClient.disconnect();

    const room = liveKitMock.roomInstances[0] as InstanceType<typeof liveKitMock.MockRoom>;
    expect(room.disconnect).toHaveBeenCalled();
  });
});

describe("SignalingChannel initial handshake", () => {
  class FakeWebSocket {
    static OPEN = 1;

    static instances: FakeWebSocket[] = [];

    readyState = FakeWebSocket.OPEN;
    onopen: (() => void) | null = null;
    onmessage: ((event: FakeWebSocketMessageEvent) => void) | null = null;
    onclose: ((event: FakeWebSocketCloseEvent) => void) | null = null;
    sentMessages: unknown[] = [];

    constructor(readonly url: string) {
      FakeWebSocket.instances.push(this);
    }

    send(data: string): void {
      this.sentMessages.push(JSON.parse(data));
    }

    close(): void {
      this.onclose?.({ code: 1000, reason: "closed" });
    }

    receive(message: unknown): void {
      this.onmessage?.({ data: JSON.stringify(message) });
    }
  }

  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defers initial set_image until room info arrives, exposes ack as a separate promise", async () => {
    const { SignalingChannel } = await import("../src/realtime/signaling-channel.js");
    const channel = new SignalingChannel({ url: "wss://example.test/realtime" });

    const openPromise = channel.openAndJoin({
      initialState: { image: "base64-image", prompt: "wear a hat", enhance: false },
    });

    const ws = FakeWebSocket.instances[0];
    ws.onopen?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(ws.sentMessages).toEqual([{ type: "livekit_join" }]);

    ws.receive({
      type: "livekit_room_info",
      livekit_url: "wss://livekit.example.test",
      token: "token",
      room_name: "room",
      session_id: "session",
    });

    const { roomInfo, initialStateAck } = await openPromise;
    expect(roomInfo).toEqual({
      livekitUrl: "wss://livekit.example.test",
      token: "token",
      roomName: "room",
      sessionId: "session",
    });
    expect(ws.sentMessages).toEqual([
      { type: "livekit_join" },
      { type: "set_image", image_data: "base64-image", prompt: "wear a hat", enhance_prompt: false },
    ]);

    let ackResolved = false;
    initialStateAck.then(() => {
      ackResolved = true;
    });
    await Promise.resolve();
    expect(ackResolved).toBe(false);

    ws.receive({ type: "set_image_ack", success: true, error: null });
    await expect(initialStateAck).resolves.toBeUndefined();
    expect(ackResolved).toBe(true);
  });

  it("defers initial null set_image until room info arrives", async () => {
    const { SignalingChannel } = await import("../src/realtime/signaling-channel.js");
    const channel = new SignalingChannel({ url: "wss://example.test/realtime" });

    const openPromise = channel.openAndJoin({
      initialState: { image: null, prompt: null },
    });

    const ws = FakeWebSocket.instances[0];
    ws.onopen?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(ws.sentMessages).toEqual([{ type: "livekit_join" }]);

    ws.receive({
      type: "livekit_room_info",
      livekit_url: "wss://livekit.example.test",
      token: "token",
      room_name: "room",
      session_id: "session",
    });

    const { roomInfo, initialStateAck } = await openPromise;
    expect(roomInfo.roomName).toBe("room");
    expect(ws.sentMessages).toEqual([{ type: "livekit_join" }, { type: "set_image", image_data: null, prompt: null }]);

    let ackResolved = false;
    initialStateAck.then(() => {
      ackResolved = true;
    });
    await Promise.resolve();
    expect(ackResolved).toBe(false);

    ws.receive({ type: "set_image_ack", success: true, error: null });
    await expect(initialStateAck).resolves.toBeUndefined();
    expect(ackResolved).toBe(true);
  });

  it("rejects pending initial-state ack on server error", async () => {
    const { SignalingChannel } = await import("../src/realtime/signaling-channel.js");
    const channel = new SignalingChannel({ url: "wss://example.test/realtime" });

    const openPromise = channel.openAndJoin({
      initialState: { image: "base64-image" },
    });

    const ws = FakeWebSocket.instances[0];
    ws.onopen?.();
    await flushMicrotasks();

    ws.receive({
      type: "livekit_room_info",
      livekit_url: "wss://livekit.example.test",
      token: "token",
      room_name: "room",
      session_id: "session",
    });

    const { initialStateAck } = await openPromise;
    ws.receive({ type: "error", error: "initial state failed" });

    await expect(initialStateAck).rejects.toThrow("initial state failed");
  });

  it("rejects pending initial-state ack on close", async () => {
    const { SignalingChannel } = await import("../src/realtime/signaling-channel.js");
    const channel = new SignalingChannel({ url: "wss://example.test/realtime" });

    const openPromise = channel.openAndJoin({
      initialState: { image: "base64-image" },
    });

    const ws = FakeWebSocket.instances[0];
    ws.onopen?.();
    await flushMicrotasks();

    ws.receive({
      type: "livekit_room_info",
      livekit_url: "wss://livekit.example.test",
      token: "token",
      room_name: "room",
      session_id: "session",
    });

    const { initialStateAck } = await openPromise;
    ws.onclose?.({ code: 1006, reason: "dropped" });

    await expect(initialStateAck).rejects.toThrow("WebSocket closed: 1006 dropped");
  });

  it("does not start the initial-state ack timer while waiting in queue", async () => {
    vi.useFakeTimers();
    try {
      const { SignalingChannel } = await import("../src/realtime/signaling-channel.js");
      const channel = new SignalingChannel({ url: "wss://example.test/realtime" });

      const openPromise = channel.openAndJoin({
        initialState: { image: "base64-image" },
      });
      openPromise.catch(() => {});

      const ws = FakeWebSocket.instances[0];
      ws.onopen?.();
      await flushMicrotasks();
      expect(ws.sentMessages).toEqual([{ type: "livekit_join" }]);

      ws.receive({ type: "queue_position", position: 5, queue_size: 10 });
      await vi.advanceTimersByTimeAsync(REALTIME_CONFIG.signaling.requestTimeoutMs * 2);
      expect(ws.sentMessages).toEqual([{ type: "livekit_join" }]);

      ws.receive({ type: "queue_position", position: 1, queue_size: 10 });
      ws.receive({
        type: "livekit_room_info",
        livekit_url: "wss://livekit.example.test",
        token: "token",
        room_name: "room",
        session_id: "session",
      });

      const { initialStateAck } = await openPromise;
      expect(ws.sentMessages).toEqual([{ type: "livekit_join" }, { type: "set_image", image_data: "base64-image" }]);

      ws.receive({ type: "set_image_ack", success: true, error: null });
      await expect(initialStateAck).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects pending initial-state ack on timeout", async () => {
    vi.useFakeTimers();
    try {
      const { SignalingChannel } = await import("../src/realtime/signaling-channel.js");
      const channel = new SignalingChannel({ url: "wss://example.test/realtime" });

      const openPromise = channel.openAndJoin({
        initialState: { image: "base64-image" },
      });

      const ws = FakeWebSocket.instances[0];
      ws.onopen?.();
      await flushMicrotasks();

      ws.receive({
        type: "livekit_room_info",
        livekit_url: "wss://livekit.example.test",
        token: "token",
        room_name: "room",
        session_id: "session",
      });

      const { initialStateAck } = await openPromise;
      await vi.advanceTimersByTimeAsync(REALTIME_CONFIG.signaling.requestTimeoutMs);

      await expect(initialStateAck).rejects.toThrow("Image send timed out");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("InitialStateGate", () => {
  it("waits for caller initial state and reports a current attempt after ack", async () => {
    const { InitialStateGate } = await import("../src/realtime/initial-state-gate.js");
    const gate = new InitialStateGate();
    let ackInitialState!: () => void;
    const initialStateAck = new Promise<void>((resolve) => {
      ackInitialState = resolve;
    });

    const attempt = gate.startAttempt({ prompt: "wear a hat" });
    let resolved = false;
    const readiness = attempt.waitForReadiness(initialStateAck).then((isCurrent) => {
      resolved = true;
      return isCurrent;
    });
    await flushMicrotasks();
    expect(resolved).toBe(false);

    ackInitialState();
    await expect(readiness).resolves.toBe(true);
  });

  it("does not gate the internal null-image bootstrap", async () => {
    const { InitialStateGate } = await import("../src/realtime/initial-state-gate.js");
    const gate = new InitialStateGate();
    const attempt = gate.startAttempt({ image: null, prompt: null });

    await expect(attempt.waitForReadiness(new Promise(() => {}))).resolves.toBe(true);
  });

  it("reports stale startup attempts after reset", async () => {
    const { InitialStateGate } = await import("../src/realtime/initial-state-gate.js");
    const gate = new InitialStateGate();
    let ackInitialState!: () => void;
    const initialStateAck = new Promise<void>((resolve) => {
      ackInitialState = resolve;
    });

    const attempt = gate.startAttempt({ image: "base64-image" });
    const readiness = attempt.waitForReadiness(initialStateAck);

    gate.reset();
    ackInitialState();

    await expect(readiness).resolves.toBe(false);
  });
});

describe("StreamSession startup orchestration", () => {
  class FakeWebSocket {
    static OPEN = 1;

    static instances: FakeWebSocket[] = [];

    readyState = FakeWebSocket.OPEN;
    onopen: (() => void) | null = null;
    onmessage: ((event: FakeWebSocketMessageEvent) => void) | null = null;
    onclose: ((event: FakeWebSocketCloseEvent) => void) | null = null;
    sentMessages: unknown[] = [];

    constructor(readonly url: string) {
      FakeWebSocket.instances.push(this);
    }

    send(data: string): void {
      this.sentMessages.push(JSON.parse(data));
    }

    close(): void {
      this.onclose?.({ code: 1000, reason: "closed" });
    }

    receive(message: unknown): void {
      this.onmessage?.({ data: JSON.stringify(message) });
    }
  }

  const sendRoomInfo = (ws: FakeWebSocket, roomName = "room") => {
    ws.receive({
      type: "livekit_room_info",
      livekit_url: "wss://livekit.example.test",
      token: "token",
      room_name: roomName,
      session_id: `session-${roomName}`,
    });
  };

  const subscribeRemoteTrack = () => {
    const room = liveKitMock.roomInstances.at(-1) as InstanceType<typeof liveKitMock.MockRoom>;
    const mediaStreamTrack = { id: "remote-video", kind: "video" };
    const track = {
      kind: liveKitMock.Track.Kind.Video,
      mediaStreamTrack,
      attach: vi.fn(),
      on: vi.fn(),
    };
    room.emit(liveKitMock.RoomEvent.TrackSubscribed, track, {}, { identity: "inference-server-1" });
  };

  const createLocalStream = () =>
    new MediaStream([
      { id: "local-video", kind: "video" },
      { id: "local-audio", kind: "audio" },
    ] as unknown[]) as MediaStream;

  beforeEach(() => {
    FakeWebSocket.instances = [];
    liveKitMock.roomInstances.length = 0;
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("MediaStream", FakeMediaStream);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("starts LiveKit after room info, but resolves connect and emits connected only after caller initial-state ack", async () => {
    const { StreamSession } = await import("../src/realtime/stream-session.js");
    const session = new StreamSession({
      url: "wss://example.test/realtime",
      localStream: null,
      initialPrompt: { text: "wear a hat", enhance: false },
    });
    const states: string[] = [];
    session.on("connectionChange", (state) => states.push(state));

    const connectPromise = session.connect();
    const ws = FakeWebSocket.instances[0];
    ws.onopen?.();
    await flushMicrotasks();

    expect(ws.sentMessages).toEqual([{ type: "livekit_join" }]);

    sendRoomInfo(ws);
    await flushMicrotasks();

    expect(ws.sentMessages).toEqual([
      { type: "livekit_join" },
      { type: "prompt", prompt: "wear a hat", enhance_prompt: false },
    ]);

    const room = liveKitMock.roomInstances[0] as InstanceType<typeof liveKitMock.MockRoom>;
    expect(room.connect).toHaveBeenCalledWith("wss://livekit.example.test", "token");
    expect(states).toEqual(["connecting"]);

    let resolved = false;
    connectPromise.then(() => {
      resolved = true;
    });
    await flushMicrotasks();
    expect(resolved).toBe(false);

    ws.receive({ type: "prompt_ack", prompt: "wear a hat", success: true, error: null });
    await expect(connectPromise).resolves.toBeUndefined();
    expect(states).toEqual(["connecting", "connected"]);
  });

  it("transitions to generating on generation_started over the websocket", async () => {
    const { StreamSession } = await import("../src/realtime/stream-session.js");
    const session = new StreamSession({
      url: "wss://example.test/realtime",
      localStream: null,
      initialPrompt: { text: "wear a hat", enhance: false },
    });
    const states: string[] = [];
    session.on("connectionChange", (state) => states.push(state));

    const connectPromise = session.connect();
    const ws = FakeWebSocket.instances[0];
    ws.onopen?.();
    await flushMicrotasks();
    sendRoomInfo(ws);
    await flushMicrotasks();

    ws.receive({ type: "prompt_ack", prompt: "wear a hat", success: true, error: null });
    await expect(connectPromise).resolves.toBeUndefined();
    expect(states).toEqual(["connecting", "connected"]);

    ws.receive({ type: "generation_started" });
    expect(states).toEqual(["connecting", "connected", "generating"]);
    expect(session.getConnectionState()).toBe("generating");

    // Subsequent ticks must not re-emit the transition.
    ws.receive({ type: "generation_tick", seconds: 5 });
    expect(states).toEqual(["connecting", "connected", "generating"]);
  });

  it("transitions to generating on the first generation_tick as a fallback", async () => {
    const { StreamSession } = await import("../src/realtime/stream-session.js");
    const session = new StreamSession({
      url: "wss://example.test/realtime",
      localStream: null,
      initialPrompt: { text: "wear a hat", enhance: false },
    });
    const states: string[] = [];
    session.on("connectionChange", (state) => states.push(state));

    const connectPromise = session.connect();
    const ws = FakeWebSocket.instances[0];
    ws.onopen?.();
    await flushMicrotasks();
    sendRoomInfo(ws);
    await flushMicrotasks();

    ws.receive({ type: "prompt_ack", prompt: "wear a hat", success: true, error: null });
    await expect(connectPromise).resolves.toBeUndefined();
    expect(states).toEqual(["connecting", "connected"]);

    ws.receive({ type: "generation_tick", seconds: 5 });
    expect(states).toEqual(["connecting", "connected", "generating"]);
  });

  it("emits remoteStream before caller initial-state ack while connect remains pending", async () => {
    const { StreamSession } = await import("../src/realtime/stream-session.js");
    const session = new StreamSession({
      url: "wss://example.test/realtime",
      localStream: null,
      initialImage: "base64-image",
      initialPrompt: { text: "wear a hat" },
    });
    const states: string[] = [];
    const remoteStreams: MediaStream[] = [];
    session.on("connectionChange", (state) => states.push(state));
    session.on("remoteStream", (stream) => remoteStreams.push(stream));

    const connectPromise = session.connect();
    const ws = FakeWebSocket.instances[0];
    ws.onopen?.();
    await flushMicrotasks();
    sendRoomInfo(ws);
    await flushMicrotasks();

    subscribeRemoteTrack();
    expect(remoteStreams).toHaveLength(1);
    expect(states).toEqual(["connecting"]);

    let resolved = false;
    connectPromise.then(() => {
      resolved = true;
    });
    await flushMicrotasks();
    expect(resolved).toBe(false);

    ws.receive({ type: "set_image_ack", success: true, error: null });
    await expect(connectPromise).resolves.toBeUndefined();
    expect(states).toEqual(["connecting", "connected"]);
  });

  it("waits for caller initial-state ack before publishing local tracks", async () => {
    const { StreamSession } = await import("../src/realtime/stream-session.js");
    const localStream = createLocalStream();
    const session = new StreamSession({
      url: "wss://example.test/realtime",
      localStream,
      initialPrompt: { text: "wear a hat", enhance: false },
    });

    const connectPromise = session.connect();
    const ws = FakeWebSocket.instances[0];
    ws.onopen?.();
    await flushMicrotasks();
    sendRoomInfo(ws);
    await flushMicrotasks();

    const room = liveKitMock.roomInstances[0] as InstanceType<typeof liveKitMock.MockRoom>;
    expect(room.connect).toHaveBeenCalledWith("wss://livekit.example.test", "token");
    expect(room.localParticipant.publishTrack).not.toHaveBeenCalled();

    ws.receive({ type: "prompt_ack", prompt: "wear a hat", success: true, error: null });
    await expect(connectPromise).resolves.toBeUndefined();
    expect(room.localParticipant.publishTrack).toHaveBeenCalledTimes(2);
    expect(room.localParticipant.publishTrack).toHaveBeenNthCalledWith(
      1,
      localStream.getTracks()[0],
      expect.objectContaining({ source: liveKitMock.Track.Source.Camera }),
    );
    expect(room.localParticipant.publishTrack).toHaveBeenNthCalledWith(2, localStream.getTracks()[1]);
  });

  it("does not gate remoteStream or connected state on the internal null-image bootstrap ack", async () => {
    const { StreamSession } = await import("../src/realtime/stream-session.js");
    const localStream = createLocalStream();
    const session = new StreamSession({
      url: "wss://example.test/realtime",
      localStream,
    });
    const states: string[] = [];
    const remoteStreams: MediaStream[] = [];
    session.on("connectionChange", (state) => states.push(state));
    session.on("remoteStream", (stream) => remoteStreams.push(stream));

    const connectPromise = session.connect();
    const ws = FakeWebSocket.instances[0];
    ws.onopen?.();
    await flushMicrotasks();
    expect(ws.sentMessages).toEqual([{ type: "livekit_join" }]);

    sendRoomInfo(ws);
    await flushMicrotasks();
    expect(ws.sentMessages).toEqual([{ type: "livekit_join" }, { type: "set_image", image_data: null, prompt: null }]);
    subscribeRemoteTrack();

    const room = liveKitMock.roomInstances[0] as InstanceType<typeof liveKitMock.MockRoom>;
    await expect(connectPromise).resolves.toBeUndefined();
    expect(room.localParticipant.publishTrack).toHaveBeenCalledTimes(2);
    expect(remoteStreams).toHaveLength(1);
    expect(states).toEqual(["connecting", "connected"]);
  });

  it("tears down media and signaling, then retries when caller initial-state ack fails", async () => {
    vi.useFakeTimers();
    const { StreamSession } = await import("../src/realtime/stream-session.js");
    const session = new StreamSession({
      url: "wss://example.test/realtime",
      localStream: null,
      initialImage: "base64-image",
    });

    const connectPromise = session.connect();
    const firstWs = FakeWebSocket.instances[0];
    firstWs.onopen?.();
    await flushMicrotasks();
    sendRoomInfo(firstWs, "first");
    await flushMicrotasks();

    const firstRoom = liveKitMock.roomInstances[0] as InstanceType<typeof liveKitMock.MockRoom>;
    firstWs.receive({ type: "set_image_ack", success: false, error: "bad image" });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(0);

    expect(firstRoom.disconnect).toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(REALTIME_CONFIG.session.retry.minTimeout);
    const secondWs = FakeWebSocket.instances[1];
    expect(secondWs).toBeDefined();
    secondWs.onopen?.();
    await flushMicrotasks();
    expect(secondWs.sentMessages).toEqual([{ type: "livekit_join" }]);

    sendRoomInfo(secondWs, "second");
    await flushMicrotasks();
    expect(secondWs.sentMessages).toEqual([
      { type: "livekit_join" },
      { type: "set_image", image_data: "base64-image" },
    ]);
    secondWs.receive({ type: "set_image_ack", success: true, error: null });
    await expect(connectPromise).resolves.toBeUndefined();
  });

  it("does not publish local tracks from a stale startup attempt", async () => {
    const { StreamSession } = await import("../src/realtime/stream-session.js");
    const session = new StreamSession({
      url: "wss://example.test/realtime",
      localStream: createLocalStream(),
      initialPrompt: { text: "make it cinematic" },
    });

    const connectPromise = session.connect();
    const firstWs = FakeWebSocket.instances[0];
    firstWs.onopen?.();
    await flushMicrotasks();
    sendRoomInfo(firstWs, "first");
    await flushMicrotasks();

    const firstRoom = liveKitMock.roomInstances[0] as InstanceType<typeof liveKitMock.MockRoom>;
    expect(firstRoom.localParticipant.publishTrack).not.toHaveBeenCalled();

    session.disconnect();
    firstWs.receive({ type: "prompt_ack", prompt: "make it cinematic", success: true, error: null });
    await flushMicrotasks();

    expect(firstRoom.localParticipant.publishTrack).not.toHaveBeenCalled();
    await expect(connectPromise).rejects.toThrow("WebSocket closed: 1000 closed");
  });
});

describe("WebRTC Error Classification", () => {
  it("classifies websocket errors", async () => {
    const { classifyWebrtcError, ERROR_CODES } = await import("../src/utils/errors.js");
    const result = classifyWebrtcError(new Error("WebSocket connection closed"));
    expect(result.code).toBe(ERROR_CODES.WEBRTC_WEBSOCKET_ERROR);
  });

  it("classifies ICE errors", async () => {
    const { classifyWebrtcError, ERROR_CODES } = await import("../src/utils/errors.js");
    const result = classifyWebrtcError(new Error("ICE connection failed"));
    expect(result.code).toBe(ERROR_CODES.WEBRTC_ICE_ERROR);
  });

  it("classifies timeout errors", async () => {
    const { classifyWebrtcError, ERROR_CODES } = await import("../src/utils/errors.js");
    const result = classifyWebrtcError(new Error("Connection timed out"));
    expect(result.code).toBe(ERROR_CODES.WEBRTC_TIMEOUT_ERROR);
    expect(result.message).toBe("connection timed out");
    expect(result.data).toEqual({ phase: "connection" });
  });

  it("classifies server-originated errors", async () => {
    const { classifyWebrtcError, ERROR_CODES } = await import("../src/utils/errors.js");
    const error = new Error("Insufficient credits") as ServerError;
    error.source = "server";
    const result = classifyWebrtcError(error);
    expect(result.code).toBe(ERROR_CODES.WEBRTC_SERVER_ERROR);
    expect(result.message).toBe("Insufficient credits");
  });

  it("classifies unknown errors as signaling errors", async () => {
    const { classifyWebrtcError, ERROR_CODES } = await import("../src/utils/errors.js");
    const result = classifyWebrtcError(new Error("room join failed"));
    expect(result.code).toBe(ERROR_CODES.WEBRTC_SIGNALING_ERROR);
  });

  it("createWebrtcTimeoutError includes phase and timeout data", async () => {
    const { createWebrtcTimeoutError, ERROR_CODES } = await import("../src/utils/errors.js");
    const result = createWebrtcTimeoutError("webrtc-handshake", REALTIME_CONFIG.signaling.requestTimeoutMs);
    expect(result.code).toBe(ERROR_CODES.WEBRTC_TIMEOUT_ERROR);
    expect(result.message).toBe(`webrtc-handshake timed out after ${REALTIME_CONFIG.signaling.requestTimeoutMs}ms`);
    expect(result.data).toEqual({ phase: "webrtc-handshake", timeoutMs: REALTIME_CONFIG.signaling.requestTimeoutMs });
  });

  it("createWebrtcServerError preserves the message", async () => {
    const { createWebrtcServerError, ERROR_CODES } = await import("../src/utils/errors.js");
    const result = createWebrtcServerError("Server overloaded");
    expect(result.code).toBe(ERROR_CODES.WEBRTC_SERVER_ERROR);
    expect(result.message).toBe("Server overloaded");
  });

  it("factory functions preserve the cause error", async () => {
    const { createWebrtcWebsocketError } = await import("../src/utils/errors.js");
    const cause = new Error("original");
    const result = createWebrtcWebsocketError(cause);
    expect(result.cause).toBe(cause);
  });
});
