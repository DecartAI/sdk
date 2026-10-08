import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDecartClient, ERROR_CODES, models } from "../src/index.js";
import { prepareBrowserConnection } from "../src/realtime/browser/prepare-connection.js";
import { REALTIME_CONFIG } from "../src/realtime/config-realtime.js";
import { createLiveKitMediaChannel, type MediaChannel } from "../src/realtime/media-channel.js";
import type { CapacityWait, ServerError } from "../src/realtime/types.js";
import type { DecartSDKError } from "../src/utils/errors.js";
import { clientTokenJwt, expAt } from "./helpers/client-token.js";

const liveKitMock = vi.hoisted(() => {
  const roomInstances: MockRoom[] = [];
  const connectMocks: Array<() => Promise<void>> = [];

  const RoomEvent = {
    TrackPublished: "trackPublished",
    TrackSubscribed: "trackSubscribed",
    Reconnected: "reconnected",
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

  class MockPublication {
    setSubscribed = vi.fn();
    constructor(public readonly kind: "video" | "audio") {}
  }
  class MockRemoteParticipant {
    trackPublications = new Map<string, MockPublication>();
    constructor(public readonly identity: string) {}
  }

  class MockRoom {
    handlers = new Map<string, Array<(...args: unknown[]) => void>>();
    state = ConnectionState.Connected;
    localParticipant = {
      publishTrack: vi.fn(),
      videoTrackPublications: new Map<string, { videoTrack: { replaceTrack: ReturnType<typeof vi.fn> } }>(),
    };
    remoteParticipants = new Map<string, MockRemoteParticipant>();
    connect = vi.fn().mockImplementation(() => connectMocks.shift()?.() ?? Promise.resolve());
    disconnect = vi.fn().mockResolvedValue(undefined);
    /** Inner publisher `setRemoteDescription` (livekit-client internal) — kept so tests can see what reached it. */
    publisherAnswers = vi.fn().mockResolvedValue(true);
    engine = { pcManager: { publisher: { setRemoteDescription: this.publisherAnswers } } };
    readonly options: unknown;

    constructor(options?: unknown) {
      this.options = options;
      roomInstances.push(this);
      const lp = this.localParticipant;
      lp.publishTrack.mockImplementation((track: { kind?: string }) => {
        if (track?.kind === "video") {
          lp.videoTrackPublications.set("camera", {
            videoTrack: { replaceTrack: vi.fn().mockResolvedValue(undefined) },
          });
        }
        return Promise.resolve(undefined);
      });
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

  return {
    roomInstances,
    connectMocks,
    RoomEvent,
    Track,
    TrackEvent,
    ConnectionState,
    MockRoom,
    MockPublication,
    MockRemoteParticipant,
  };
});

vi.mock("livekit-client", () => ({
  Room: liveKitMock.MockRoom,
  RoomEvent: liveKitMock.RoomEvent,
  Track: liveKitMock.Track,
  TrackEvent: liveKitMock.TrackEvent,
  ConnectionState: liveKitMock.ConnectionState,
}));

const logger = { debug() {}, info() {}, warn() {}, error() {} };

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

  getAudioTracks(): unknown[] {
    return this.tracks.filter((track) => (track as { kind?: string }).kind === "audio");
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
      // The 720/640 release set: the pod snaps the generation shape from the
      // first input frame's aspect ratio, so the capture should be native 720p.
      const lucyModel = models.realtime("lucy-2.1");
      expect(lucyModel.width).toBe(1280);
      expect(lucyModel.height).toBe(720);
    });

    it("lucy-latest captures at the same 720p shape as the model it resolves to", () => {
      const latest = models.realtime("lucy-latest");
      expect(latest.width).toBe(1280);
      expect(latest.height).toBe(720);
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

  it("preserves the frame-timing requirement in subscribe tokens", async () => {
    const { encodeSubscribeToken } = await import("../src/realtime/stream-session.js");
    const { decodeSubscribeToken } = await import("../src/realtime/subscribe-client.js");
    const token = encodeSubscribeToken("session-abc123", { frameTiming: true });

    expect(decodeSubscribeToken(token)).toEqual({ room_name: "session-abc123", frame_timing: true });
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

describe("realtime.subscribe", () => {
  beforeEach(() => {
    liveKitMock.roomInstances.length = 0;
    liveKitMock.connectMocks.length = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ livekit_url: "wss://livekit.example.test", token: "watch-token", room_name: "room-1" }),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("configures a frame-metadata worker for browser subscribe rooms when available", async () => {
    const { createRealTimeSubscribeClient } = await import("../src/realtime/subscribe-client.js");
    const worker = { terminate: vi.fn() } as unknown as Worker;
    const subscriber = createRealTimeSubscribeClient({
      baseUrl: "https://api.example.test",
      apiKey: "test-key",
      logger,
      createFrameMetadataWorker: () => worker,
      isFrameMetadataRuntimeSupported: () => true,
    });

    const client = await subscriber.subscribe({
      token: btoa(JSON.stringify({ room_name: "room-1", frame_timing: true })),
      onRemoteStream: () => {},
    });

    const room = liveKitMock.roomInstances[0] as InstanceType<typeof liveKitMock.MockRoom>;
    expect(room.options).toMatchObject({ frameMetadata: { worker } });
    expect(room.connect).toHaveBeenCalledWith("wss://livekit.example.test", "watch-token");
    client.disconnect();
  });

  it("asks apiKeyProvider for the watch-stream credential instead of the static key", async () => {
    const { createRealTimeSubscribeClient } = await import("../src/realtime/subscribe-client.js");
    const apiKeyProvider = vi.fn(async () => "fresh-viewer-token");
    const subscriber = createRealTimeSubscribeClient({
      baseUrl: "https://api.example.test",
      apiKey: "stale-key",
      apiKeyProvider,
      logger,
    });

    const client = await subscriber.subscribe({
      token: btoa(JSON.stringify({ room_name: "room-1" })),
      onRemoteStream: () => {},
    });

    expect(apiKeyProvider).toHaveBeenCalledTimes(1);
    const [, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("fresh-viewer-token");
    client.disconnect();
  });

  it("refuses an expired client token before fetching watch-stream credentials", async () => {
    const { createRealTimeSubscribeClient } = await import("../src/realtime/subscribe-client.js");
    const now = Date.UTC(2026, 9, 7, 12, 0, 0);
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    const subscriber = createRealTimeSubscribeClient({
      baseUrl: "https://api.example.test",
      apiKey: clientTokenJwt({ exp: expAt(now, -600) }),
      logger,
    });

    try {
      await expect(
        subscriber.subscribe({ token: btoa(JSON.stringify({ room_name: "room-1" })), onRemoteStream: () => {} }),
      ).rejects.toMatchObject({ code: ERROR_CODES.TOKEN_EXPIRED, data: { expiredSecondsAgo: 600 } });
    } finally {
      nowSpy.mockRestore();
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(liveKitMock.roomInstances).toHaveLength(0);
  });

  it("lets an apiKeyProvider rejection reach the subscriber unchanged", async () => {
    const { createRealTimeSubscribeClient } = await import("../src/realtime/subscribe-client.js");
    const failure = new Error("token endpoint answered 503");
    const subscriber = createRealTimeSubscribeClient({
      baseUrl: "https://api.example.test",
      apiKey: "",
      apiKeyProvider: () => Promise.reject(failure),
      logger,
    });

    await expect(
      subscriber.subscribe({ token: btoa(JSON.stringify({ room_name: "room-1" })), onRemoteStream: () => {} }),
    ).rejects.toBe(failure);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("terminates the frame-metadata worker when subscribe connect fails", async () => {
    const { createRealTimeSubscribeClient } = await import("../src/realtime/subscribe-client.js");
    const worker = { terminate: vi.fn() } as unknown as Worker;
    liveKitMock.connectMocks.push(() => Promise.reject(new Error("connect failed")));
    const subscriber = createRealTimeSubscribeClient({
      baseUrl: "https://api.example.test",
      apiKey: "test-key",
      logger,
      createFrameMetadataWorker: () => worker,
      isFrameMetadataRuntimeSupported: () => true,
    });

    await expect(
      subscriber.subscribe({
        token: btoa(JSON.stringify({ room_name: "room-1", frame_timing: true })),
        onRemoteStream: () => {},
      }),
    ).rejects.toMatchObject({ code: "WEBRTC_SIGNALING_ERROR" });

    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("fails fast when a frame-timed subscribe stream cannot create the worker", async () => {
    const { createRealTimeSubscribeClient } = await import("../src/realtime/subscribe-client.js");
    const subscriber = createRealTimeSubscribeClient({
      baseUrl: "https://api.example.test",
      apiKey: "test-key",
      logger,
      isFrameMetadataRuntimeSupported: () => true,
      createFrameMetadataWorker: () => {
        throw new Error("worker blocked");
      },
    });

    await expect(
      subscriber.subscribe({
        token: btoa(JSON.stringify({ room_name: "room-1", frame_timing: true })),
        onRemoteStream: () => {},
      }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_PLATFORM_FEATURE",
      message: expect.stringMatching(/requires LiveKit frame metadata.*worker blocked/),
    });
    expect(liveKitMock.roomInstances).toHaveLength(0);
  });

  it("keeps legacy non-frame-timed subscribe tokens working without the worker", async () => {
    const { createRealTimeSubscribeClient } = await import("../src/realtime/subscribe-client.js");
    const subscriber = createRealTimeSubscribeClient({
      baseUrl: "https://api.example.test",
      apiKey: "test-key",
      logger,
      isFrameMetadataRuntimeSupported: () => true,
      createFrameMetadataWorker: () => {
        throw new Error("worker blocked");
      },
    });

    const client = await subscriber.subscribe({
      token: btoa(JSON.stringify({ room_name: "room-1" })),
      onRemoteStream: () => {},
    });

    const room = liveKitMock.roomInstances[0] as InstanceType<typeof liveKitMock.MockRoom>;
    expect(room.options).not.toHaveProperty("frameMetadata");
    client.disconnect();
  });

  it("fails frame-timed subscribe tokens when encoded transforms are unavailable", async () => {
    const { createRealTimeSubscribeClient } = await import("../src/realtime/subscribe-client.js");
    const subscriber = createRealTimeSubscribeClient({
      baseUrl: "https://api.example.test",
      apiKey: "test-key",
      logger,
      createFrameMetadataWorker: () => {
        throw new Error("should not create");
      },
      isFrameMetadataRuntimeSupported: () => false,
    });

    await expect(
      subscriber.subscribe({
        token: btoa(JSON.stringify({ room_name: "room-1", frame_timing: true })),
        onRemoteStream: () => {},
      }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_PLATFORM_FEATURE",
      message: expect.stringContaining("encoded transforms are unavailable"),
    });
    expect(liveKitMock.roomInstances).toHaveLength(0);
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

    constructor(readonly url: string) {
      FakeWebSocket.instances.push(this);
      setTimeout(() => this.onopen?.(), 0);
    }

    send(data: string): void {
      const message = JSON.parse(data);
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
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("MediaStream", FakeMediaStream);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("adds resolution to the realtime URL when provided", async () => {
    const { createRealTimeClient } = await import("../src/realtime/client.js");
    const client = createRealTimeClient({
      baseUrl: "wss://api3.decart.ai",
      apiKey: "test-key",
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      telemetryEnabled: false,
      prepareConnection: prepareBrowserConnection,
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

  const createClientWithLogger = async (logger: {
    debug(): void;
    info(): void;
    warn(message: string, data?: Record<string, unknown>): void;
    error(): void;
  }) => {
    const { createRealTimeClient } = await import("../src/realtime/client.js");
    return createRealTimeClient({
      baseUrl: "wss://api3.decart.ai",
      apiKey: "test-key",
      logger,
      telemetryEnabled: false,
      prepareConnection: prepareBrowserConnection,
    });
  };

  it("omits speed from the realtime URL when the option is not set", async () => {
    const client = await createClientWithLogger(logger);

    const realtimeClient = await client.connect(null, {
      model: models.realtime("lucy-2.5"),
      onRemoteStream: vi.fn(),
    });

    const url = new URL(FakeWebSocket.instances[0].url);
    expect(url.searchParams.has("speed")).toBe(false);
    expect(url.search).not.toContain("speed");
    realtimeClient.disconnect();
  });

  it("adds speed=fast to the realtime URL exactly once when provided", async () => {
    const client = await createClientWithLogger(logger);

    const realtimeClient = await client.connect(null, {
      model: models.realtime("lucy-2.5"),
      speed: "fast",
      onRemoteStream: vi.fn(),
    });

    const rawUrl = FakeWebSocket.instances[0].url;
    const url = new URL(rawUrl);
    expect(url.searchParams.getAll("speed")).toEqual(["fast"]);
    expect(rawUrl.match(/[?&]speed=/g)).toHaveLength(1);
    expect(rawUrl).toContain("&speed=fast");
    // Unrelated params are untouched.
    expect(url.searchParams.get("model")).toBe("lucy-2.5");
    expect(url.searchParams.get("api_key")).toBe("test-key");
    realtimeClient.disconnect();
  });

  it("lets the typed speed option win over queryParams.speed", async () => {
    const client = await createClientWithLogger(logger);

    const realtimeClient = await client.connect(null, {
      model: models.realtime("lucy-2.5"),
      speed: "fast",
      queryParams: { speed: "slow", pool: "custom" },
      onRemoteStream: vi.fn(),
    });

    const url = new URL(FakeWebSocket.instances[0].url);
    expect(url.searchParams.getAll("speed")).toEqual(["fast"]);
    expect(url.searchParams.get("pool")).toBe("custom");
    realtimeClient.disconnect();
  });

  it("rejects unsupported realtime speeds", async () => {
    const client = await createClientWithLogger(logger);

    await expect(
      client.connect(null, {
        model: models.realtime("lucy-2.5"),
        speed: "turbo" as never,
        onRemoteStream: vi.fn(),
      }),
    ).rejects.toThrow();
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("does not warn when the model advertises the requested speed", async () => {
    const warn = vi.fn();
    const client = await createClientWithLogger({ ...logger, warn });

    for (const name of ["lucy-2.5", "lucy-latest", "lucy-vton-3.5", "lucy-vton-latest"] as const) {
      const realtimeClient = await client.connect(null, {
        model: models.realtime(name),
        speed: "fast",
        onRemoteStream: vi.fn(),
      });
      realtimeClient.disconnect();
    }

    // Teardown emits unrelated "websocket closed" warnings; only the speed warning matters here.
    const speedWarnings = warn.mock.calls.filter(([message]) => String(message).includes("speed"));
    expect(speedWarnings).toEqual([]);
  });

  it("warns but still sends speed=fast for a model without the capability", async () => {
    const warn = vi.fn();
    const client = await createClientWithLogger({ ...logger, warn });

    const realtimeClient = await client.connect(null, {
      model: models.realtime("lucy-2.1"),
      speed: "fast",
      onRemoteStream: vi.fn(),
    });

    const speedWarnings = warn.mock.calls.filter(([message]) => String(message).includes("speed"));
    expect(speedWarnings).toHaveLength(1);
    expect(speedWarnings[0]).toEqual([
      expect.stringContaining("speed"),
      expect.objectContaining({ model: "lucy-2.1", speed: "fast", supportedSpeeds: [] }),
    ]);
    const url = new URL(FakeWebSocket.instances[0].url);
    expect(url.searchParams.getAll("speed")).toEqual(["fast"]);
    realtimeClient.disconnect();
  });

  it("keeps speed=fast on the signaling URL when the session reconnects", async () => {
    const client = await createClientWithLogger(logger);

    const realtimeClient = await client.connect(null, {
      model: models.realtime("lucy-2.5"),
      speed: "fast",
      onRemoteStream: vi.fn(),
    });
    const first = FakeWebSocket.instances[0];
    expect(new URL(first.url).searchParams.getAll("speed")).toEqual(["fast"]);

    // A non-terminal close of a connected session triggers a reconnect on a fresh socket.
    first.onclose?.({ code: 1006, reason: "" });
    await flushMicrotasks();

    const reconnected = FakeWebSocket.instances.at(-1) as FakeWebSocket;
    expect(reconnected).not.toBe(first);
    expect(reconnected.url).toBe(first.url);
    expect(new URL(reconnected.url).searchParams.getAll("speed")).toEqual(["fast"]);
    realtimeClient.disconnect();
  });

  it("retries: 0 dials once and rejects on the first transient refusal", async () => {
    class RefusingWebSocket extends FakeWebSocket {
      send(data: string): void {
        if (JSON.parse(data).type === "livekit_join") {
          setTimeout(() => this.onclose?.({ code: 1013, reason: "Try Again Later" }), 0);
        }
      }
    }
    vi.stubGlobal("WebSocket", RefusingWebSocket);
    const client = await createClientWithLogger(logger);

    await expect(
      client.connect(null, {
        model: models.realtime("lucy-2.5"),
        retries: 0,
        onRemoteStream: vi.fn(),
      }),
    ).rejects.toThrow("WebSocket closed: 1013 Try Again Later");
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("waits a capacity refusal's retry_after, reports it through onCapacityWait, and connects on the re-dial", async () => {
    class CapacityRefusingWebSocket extends FakeWebSocket {
      static refused = false;
      send(data: string): void {
        if (JSON.parse(data).type === "livekit_join" && !CapacityRefusingWebSocket.refused) {
          CapacityRefusingWebSocket.refused = true;
          setTimeout(() => {
            this.onmessage?.({
              data: JSON.stringify({
                type: "error",
                error: "Server at capacity. Please try again later.",
                error_type: "capacity",
                retry_after: 5,
              }),
            });
            this.onclose?.({ code: 1013, reason: "Try Again Later" });
          }, 0);
          return;
        }
        super.send(data);
      }
    }
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", CapacityRefusingWebSocket);
    const client = await createClientWithLogger(logger);
    const onCapacityWait = vi.fn();

    const pending = client.connect(null, {
      model: models.realtime("lucy-2.5"),
      onRemoteStream: vi.fn(),
      onCapacityWait,
    });
    pending.catch(() => {});
    // A 0 ms timer created inside a fake tick is due 1 ms later, so settle in 1 ms steps.
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(1);
    expect(onCapacityWait).toHaveBeenCalledTimes(1);
    const { retryAfterMs, attempt } = onCapacityWait.mock.calls[0][0] as CapacityWait;
    expect(attempt).toBe(1);
    expect(retryAfterMs).toBeGreaterThanOrEqual(4000);
    expect(retryAfterMs).toBeLessThanOrEqual(6000);
    // Well past the 1 s backoff floor, still waiting for the server's delay.
    await vi.advanceTimersByTimeAsync(3000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(retryAfterMs);
    expect(FakeWebSocket.instances).toHaveLength(2);

    const realtimeClient = await pending;
    expect(FakeWebSocket.instances[1].url).toBe(FakeWebSocket.instances[0].url);
    realtimeClient.disconnect();
  });

  it("rejects a negative or fractional retries option", async () => {
    const client = await createClientWithLogger(logger);

    for (const retries of [-1, 1.5]) {
      await expect(
        client.connect(null, {
          model: models.realtime("lucy-2.5"),
          retries,
          onRemoteStream: vi.fn(),
        }),
      ).rejects.toThrow();
    }
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("rejects unsupported realtime resolutions", async () => {
    const { createRealTimeClient } = await import("../src/realtime/client.js");
    const client = createRealTimeClient({
      baseUrl: "wss://api3.decart.ai",
      apiKey: "test-key",
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      telemetryEnabled: false,
      prepareConnection: prepareBrowserConnection,
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

  describe("client token expiry preflight and apiKeyProvider", () => {
    const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);
    const expIn = (seconds: number) => expAt(NOW, seconds);
    const apiKeyOf = (ws: FakeWebSocket) => new URL(ws.url).searchParams.get("api_key");

    const createClient = async (credentials: { apiKey: string; apiKeyProvider?: () => string | Promise<string> }) => {
      const { createRealTimeClient } = await import("../src/realtime/client.js");
      return createRealTimeClient({
        baseUrl: "wss://api3.decart.ai",
        ...credentials,
        logger,
        telemetryEnabled: false,
        prepareConnection: prepareBrowserConnection,
      });
    };

    it("rejects an expired client token with TOKEN_EXPIRED before opening a socket", async () => {
      vi.spyOn(Date, "now").mockReturnValue(NOW);
      const exp = expIn(-83);
      const client = await createClient({ apiKey: clientTokenJwt({ exp }) });
      const onConnectionChange = vi.fn();

      await expect(
        client.connect(null, { model: models.realtime("lucy-2.5"), onRemoteStream: vi.fn(), onConnectionChange }),
      ).rejects.toMatchObject({
        code: ERROR_CODES.TOKEN_EXPIRED,
        message: expect.stringMatching(/^Client token expired 83 s ago \(exp 2026-10-07T11:58:37\.000Z\)\./),
        data: { claim: "exp", expiresAt: new Date(exp * 1000).toISOString(), expiredSecondsAgo: 83 },
      });
      // Nothing was dialled and no state was reported: the token never left the client.
      expect(FakeWebSocket.instances).toHaveLength(0);
      expect(onConnectionChange).not.toHaveBeenCalled();
    });

    it("connects with a token inside the clock-skew tolerance, a live token and an opaque key", async () => {
      vi.spyOn(Date, "now").mockReturnValue(NOW);
      const skewed = clientTokenJwt({ exp: expIn(-REALTIME_CONFIG.session.clientTokenExpiryToleranceSeconds) });
      const live = clientTokenJwt({ exp: expIn(60) });

      for (const apiKey of [skewed, live, "ek_opaque_key"]) {
        FakeWebSocket.instances = [];
        const client = await createClient({ apiKey });
        const realtimeClient = await client.connect(null, {
          model: models.realtime("lucy-2.5"),
          onRemoteStream: vi.fn(),
        });
        expect(FakeWebSocket.instances).toHaveLength(1);
        expect(apiKeyOf(FakeWebSocket.instances[0])).toBe(apiKey);
        realtimeClient.disconnect();
      }
    });

    it("asks apiKeyProvider before the first dial and again before each reconnect", async () => {
      let minted = 0;
      const apiKeyProvider = vi.fn(async () => `fresh-${++minted}`);
      const client = await createClient({ apiKey: "", apiKeyProvider });

      const realtimeClient = await client.connect(null, {
        model: models.realtime("lucy-2.5"),
        onRemoteStream: vi.fn(),
      });
      expect(apiKeyProvider).toHaveBeenCalledTimes(1);
      const first = FakeWebSocket.instances[0];
      expect(apiKeyOf(first)).toBe("fresh-1");

      // A non-terminal close of a connected session reconnects on a fresh socket with a fresh token.
      first.onclose?.({ code: 1006, reason: "" });
      await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
      expect(apiKeyProvider).toHaveBeenCalledTimes(2);
      expect(apiKeyOf(FakeWebSocket.instances[1])).toBe("fresh-2");
      await vi.waitFor(() => expect(realtimeClient.getConnectionState()).toBe("connected"));

      FakeWebSocket.instances[1].onclose?.({ code: 1006, reason: "" });
      await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(3));
      expect(apiKeyOf(FakeWebSocket.instances[2])).toBe("fresh-3");
      realtimeClient.disconnect();
    });

    it("asks apiKeyProvider again for a connect retry after a transient refusal", async () => {
      class RefuseOnceWebSocket extends FakeWebSocket {
        static refused = false;
        send(data: string): void {
          if (JSON.parse(data).type === "livekit_join" && !RefuseOnceWebSocket.refused) {
            RefuseOnceWebSocket.refused = true;
            setTimeout(() => this.onclose?.({ code: 1013, reason: "Try Again Later" }), 0);
            return;
          }
          super.send(data);
        }
      }
      vi.stubGlobal("WebSocket", RefuseOnceWebSocket);
      let minted = 0;
      const apiKeyProvider = vi.fn(async () => `fresh-${++minted}`);
      const client = await createClient({ apiKey: "", apiKeyProvider });

      // The retry re-dials after the 1 s backoff floor, with a token minted for that dial.
      const realtimeClient = await client.connect(null, {
        model: models.realtime("lucy-2.5"),
        onRemoteStream: vi.fn(),
      });

      expect(FakeWebSocket.instances).toHaveLength(2);
      expect(apiKeyProvider).toHaveBeenCalledTimes(2);
      expect(apiKeyOf(FakeWebSocket.instances[0])).toBe("fresh-1");
      expect(apiKeyOf(FakeWebSocket.instances[1])).toBe("fresh-2");
      realtimeClient.disconnect();
    });

    it("stops a reconnect with TOKEN_EXPIRED instead of dialling when the static token expired mid-session", async () => {
      const now = vi.spyOn(Date, "now").mockReturnValue(NOW);
      const client = await createClient({ apiKey: clientTokenJwt({ exp: expIn(30) }) });
      const realtimeClient = await client.connect(null, {
        model: models.realtime("lucy-2.5"),
        onRemoteStream: vi.fn(),
      });
      const errors: DecartSDKError[] = [];
      const states: string[] = [];
      realtimeClient.on("error", (error) => errors.push(error));
      realtimeClient.on("connectionChange", (state) => states.push(state));

      now.mockReturnValue(NOW + 40_000);
      FakeWebSocket.instances[0].onclose?.({ code: 1006, reason: "" });

      await vi.waitFor(() => expect(errors).toHaveLength(1));
      expect(errors[0]).toMatchObject({
        code: ERROR_CODES.TOKEN_EXPIRED,
        data: { expiredSecondsAgo: 10 },
      });
      // One socket only: the expired token was never dialled, and no retry followed.
      expect(FakeWebSocket.instances).toHaveLength(1);
      // The buffer replays the connect-time states to the late listener; then the failed reconnect.
      expect(states).toEqual(["connecting", "connected", "reconnecting", "disconnected"]);
      expect(realtimeClient.getConnectionState()).toBe("disconnected");
    });

    it("rejects connect when apiKeyProvider returns an expired token", async () => {
      vi.spyOn(Date, "now").mockReturnValue(NOW);
      const client = await createClient({ apiKey: "", apiKeyProvider: () => clientTokenJwt({ exp: expIn(-100) }) });

      await expect(
        client.connect(null, { model: models.realtime("lucy-2.5"), onRemoteStream: vi.fn() }),
      ).rejects.toMatchObject({ code: ERROR_CODES.TOKEN_EXPIRED, data: { expiredSecondsAgo: 100 } });
      expect(FakeWebSocket.instances).toHaveLength(0);
    });

    it("rejects connect with the provider's own error when apiKeyProvider fails", async () => {
      const client = await createClient({
        apiKey: "",
        apiKeyProvider: async () => {
          throw new Error("token endpoint answered 503");
        },
      });

      await expect(
        client.connect(null, { model: models.realtime("lucy-2.5"), onRemoteStream: vi.fn() }),
      ).rejects.toThrow("token endpoint answered 503");
      expect(FakeWebSocket.instances).toHaveLength(0);
    });

    it("rejects connect when apiKeyProvider resolves to something other than a token string", async () => {
      const client = await createClient({ apiKey: "", apiKeyProvider: async () => ({ apiKey: "eyJ" }) as never });

      await expect(
        client.connect(null, { model: models.realtime("lucy-2.5"), onRemoteStream: vi.fn() }),
      ).rejects.toMatchObject({ code: ERROR_CODES.INVALID_API_KEY });
      expect(FakeWebSocket.instances).toHaveLength(0);
    });

    it("flows apiKeyProvider from createDecartClient to the realtime dial", async () => {
      const apiKeyProvider = vi.fn(async () => "fresh-from-app-server");
      const client = createDecartClient({ apiKeyProvider, telemetry: false });

      const realtimeClient = await client.realtime.connect(null, {
        model: models.realtime("lucy-2.5"),
        onRemoteStream: vi.fn(),
      });

      expect(apiKeyProvider).toHaveBeenCalledTimes(1);
      expect(apiKeyOf(FakeWebSocket.instances[0])).toBe("fresh-from-app-server");
      realtimeClient.disconnect();
    });
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

  it("sends lean livekit_join then initial set_image as its own frame, exposes ack as a separate promise", async () => {
    const { SignalingChannel } = await import("../src/realtime/signaling-channel.js");
    const channel = new SignalingChannel({ url: "wss://example.test/realtime" });

    const openPromise = channel.openAndJoin({
      initialState: { image: "base64-image", prompt: "wear a hat", enhance: false },
    });

    const leanJoin = { type: "livekit_join", passthrough: false };
    const initialImage = { type: "set_image", image_data: "base64-image", prompt: "wear a hat", enhance_prompt: false };

    const ws = FakeWebSocket.instances[0];
    ws.onopen?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(ws.sentMessages).toEqual([leanJoin, initialImage]);

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
    expect(ws.sentMessages).toEqual([leanJoin, initialImage]);

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

  it("marks the null-image bootstrap as passthrough and sends it as its own frame", async () => {
    const { SignalingChannel } = await import("../src/realtime/signaling-channel.js");
    const channel = new SignalingChannel({ url: "wss://example.test/realtime" });

    const openPromise = channel.openAndJoin({
      initialState: { image: null, prompt: null },
    });

    const leanJoin = { type: "livekit_join", passthrough: true };
    const bootstrapImage = { type: "set_image", image_data: null, prompt: null };

    const ws = FakeWebSocket.instances[0];
    ws.onopen?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(ws.sentMessages).toEqual([leanJoin, bootstrapImage]);

    ws.receive({
      type: "livekit_room_info",
      livekit_url: "wss://livekit.example.test",
      token: "token",
      room_name: "room",
      session_id: "session",
    });

    const { roomInfo, initialStateAck } = await openPromise;
    expect(roomInfo.roomName).toBe("room");
    expect(ws.sentMessages).toEqual([leanJoin, bootstrapImage]);

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

      const leanJoin = { type: "livekit_join", passthrough: false };
      const initialImage = { type: "set_image", image_data: "base64-image" };

      const ws = FakeWebSocket.instances[0];
      ws.onopen?.();
      await flushMicrotasks();
      expect(ws.sentMessages).toEqual([leanJoin, initialImage]);

      ws.receive({ type: "queue_position", position: 5, queue_size: 10 });
      await vi.advanceTimersByTimeAsync(REALTIME_CONFIG.signaling.requestTimeoutMs * 2);
      expect(ws.sentMessages).toEqual([leanJoin, initialImage]);

      ws.receive({ type: "queue_position", position: 1, queue_size: 10 });
      ws.receive({
        type: "livekit_room_info",
        livekit_url: "wss://livekit.example.test",
        token: "token",
        room_name: "room",
        session_id: "session",
      });

      const { initialStateAck } = await openPromise;
      expect(ws.sentMessages).toEqual([leanJoin, initialImage]);

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
    liveKitMock.connectMocks.length = 0;
    liveKitMock.roomInstances.length = 0;
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("MediaStream", FakeMediaStream);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("drives an injected media transport without importing transport details into the session", async () => {
    const connect = vi.fn().mockResolvedValue(undefined);
    const publishLocalTracks = vi.fn().mockResolvedValue(undefined);
    const disconnect = vi.fn();
    const mediaChannel: MediaChannel = {
      localStream: null,
      on: vi.fn(),
      off: vi.fn(),
      connect,
      publishLocalTracks,
      replaceVideoTrack: vi.fn().mockResolvedValue(undefined),
      disconnect,
    };
    const createMediaChannel = vi.fn(() => mediaChannel);
    const { StreamSession } = await import("../src/realtime/stream-session.js");
    const session = new StreamSession({
      url: "wss://example.test/realtime",
      localStream: null,
      createMediaChannel,
    });

    const connectPromise = session.connect();
    const ws = FakeWebSocket.instances[0];
    ws.onopen?.();
    await flushMicrotasks();
    sendRoomInfo(ws);
    await expect(connectPromise).resolves.toBeUndefined();

    expect(createMediaChannel).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledWith({ url: "wss://livekit.example.test", token: "token" });
    expect(publishLocalTracks).toHaveBeenCalledOnce();

    session.disconnect();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it.each([
    { frameTiming: true, expected: { room_name: "room", frame_timing: true } },
    { frameTiming: false, expected: { room_name: "room" } },
  ])("propagates frameTiming=$frameTiming into the sessionStarted subscribe token", async ({
    frameTiming,
    expected,
  }) => {
    // Viewers can only strip packet trailers if the token tells them to build
    // the worker, so the publisher's frame-timing decision has to survive the
    // round trip into the token it hands out.
    const mediaChannel: MediaChannel = {
      localStream: null,
      on: vi.fn(),
      off: vi.fn(),
      connect: vi.fn().mockResolvedValue(undefined),
      publishLocalTracks: vi.fn().mockResolvedValue(undefined),
      replaceVideoTrack: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
    };
    const { StreamSession } = await import("../src/realtime/stream-session.js");
    const { decodeSubscribeToken } = await import("../src/realtime/subscribe-client.js");
    const session = new StreamSession({
      url: "wss://example.test/realtime",
      localStream: null,
      createMediaChannel: () => mediaChannel,
      frameTiming,
    });
    const tokens: string[] = [];
    session.on("sessionStarted", ({ subscribeToken }) => tokens.push(subscribeToken));

    const connectPromise = session.connect();
    const ws = FakeWebSocket.instances[0];
    ws.onopen?.();
    await flushMicrotasks();
    sendRoomInfo(ws);
    await expect(connectPromise).resolves.toBeUndefined();

    expect(tokens).toHaveLength(1);
    expect(decodeSubscribeToken(tokens[0])).toEqual(expected);
    session.disconnect();
  });

  it("starts LiveKit after room info, then resolves connect before caller initial-state ack", async () => {
    const { StreamSession } = await import("../src/realtime/stream-session.js");
    const session = new StreamSession({
      url: "wss://example.test/realtime",
      localStream: null,
      createMediaChannel: createLiveKitMediaChannel,
      initialPrompt: { text: "wear a hat", enhance: false },
    });
    const states: string[] = [];
    session.on("connectionChange", (state) => states.push(state));

    const connectPromise = session.connect();
    const ws = FakeWebSocket.instances[0];
    ws.onopen?.();
    await flushMicrotasks();

    const leanJoin = { type: "livekit_join", passthrough: false };
    const initialPrompt = { type: "prompt", prompt: "wear a hat", enhance_prompt: false };
    expect(ws.sentMessages).toEqual([leanJoin, initialPrompt]);

    sendRoomInfo(ws);
    await flushMicrotasks();
    await vi.waitFor(() => expect(liveKitMock.roomInstances).toHaveLength(1));

    expect(ws.sentMessages).toEqual([leanJoin, initialPrompt]);

    const room = liveKitMock.roomInstances[0] as InstanceType<typeof liveKitMock.MockRoom>;
    expect(room.connect).toHaveBeenCalledWith("wss://livekit.example.test", "token", { autoSubscribe: false });
    expect(states).toEqual(["connecting"]);

    await expect(connectPromise).resolves.toBeUndefined();
    expect(states).toEqual(["connecting", "connected"]);

    ws.receive({ type: "prompt_ack", prompt: "wear a hat", success: true, error: null });
    await flushMicrotasks();
  });

  it("transitions to generating on generation_started over the websocket", async () => {
    const { StreamSession } = await import("../src/realtime/stream-session.js");
    const session = new StreamSession({
      url: "wss://example.test/realtime",
      localStream: null,
      createMediaChannel: createLiveKitMediaChannel,
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

    await expect(connectPromise).resolves.toBeUndefined();
    expect(states).toEqual(["connecting", "connected"]);

    ws.receive({ type: "generation_started" });
    expect(states).toEqual(["connecting", "connected", "generating"]);
    expect(session.getConnectionState()).toBe("generating");

    // Subsequent ticks must not re-emit the transition.
    ws.receive({ type: "generation_tick", seconds: 5 });
    expect(states).toEqual(["connecting", "connected", "generating"]);

    ws.receive({ type: "prompt_ack", prompt: "wear a hat", success: true, error: null });
    await flushMicrotasks();
  });

  it("transitions to generating on the first generation_tick as a fallback", async () => {
    const { StreamSession } = await import("../src/realtime/stream-session.js");
    const session = new StreamSession({
      url: "wss://example.test/realtime",
      localStream: null,
      createMediaChannel: createLiveKitMediaChannel,
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

    await expect(connectPromise).resolves.toBeUndefined();
    expect(states).toEqual(["connecting", "connected"]);

    ws.receive({ type: "generation_tick", seconds: 5 });
    expect(states).toEqual(["connecting", "connected", "generating"]);

    ws.receive({ type: "prompt_ack", prompt: "wear a hat", success: true, error: null });
    await flushMicrotasks();
  });

  it("emits remoteStream before caller initial-state ack after connect resolves", async () => {
    const { StreamSession } = await import("../src/realtime/stream-session.js");
    const session = new StreamSession({
      url: "wss://example.test/realtime",
      localStream: null,
      createMediaChannel: createLiveKitMediaChannel,
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
    await expect(connectPromise).resolves.toBeUndefined();
    expect(states).toEqual(["connecting", "connected"]);

    subscribeRemoteTrack();
    expect(remoteStreams).toHaveLength(1);

    ws.receive({ type: "set_image_ack", success: true, error: null });
    await flushMicrotasks();
  });

  it("publishes local tracks immediately after LiveKit connect and before caller initial-state ack", async () => {
    const { StreamSession } = await import("../src/realtime/stream-session.js");
    const localStream = createLocalStream();
    const session = new StreamSession({
      url: "wss://example.test/realtime",
      localStream,
      createMediaChannel: createLiveKitMediaChannel,
      initialPrompt: { text: "wear a hat", enhance: false },
    });

    const connectPromise = session.connect();
    const ws = FakeWebSocket.instances[0];
    ws.onopen?.();
    await flushMicrotasks();
    sendRoomInfo(ws);
    await flushMicrotasks();

    const room = liveKitMock.roomInstances[0] as InstanceType<typeof liveKitMock.MockRoom>;
    expect(room.connect).toHaveBeenCalledWith("wss://livekit.example.test", "token", { autoSubscribe: false });
    await expect(connectPromise).resolves.toBeUndefined();
    expect(room.localParticipant.publishTrack).toHaveBeenCalledTimes(2);
    expect(room.localParticipant.publishTrack).toHaveBeenNthCalledWith(
      1,
      localStream.getTracks()[0],
      expect.objectContaining({ source: liveKitMock.Track.Source.Camera }),
    );
    expect(room.localParticipant.publishTrack).toHaveBeenNthCalledWith(2, localStream.getTracks()[1]);

    ws.receive({ type: "prompt_ack", prompt: "wear a hat", success: true, error: null });
    await flushMicrotasks();
  });

  it("configures the LiveKit worker and timestamps published video when frame timing is enabled", async () => {
    const localStream = createLocalStream();
    const worker = {} as Worker;
    const channel = createLiveKitMediaChannel({
      localStream,
      createFrameMetadataWorker: () => worker,
    });

    await channel.connect({ url: "wss://livekit.example.test", token: "token" });
    await channel.publishLocalTracks();

    const room = liveKitMock.roomInstances[0] as InstanceType<typeof liveKitMock.MockRoom>;
    expect(room.options).toMatchObject({ frameMetadata: { worker } });
    expect(room.localParticipant.publishTrack).toHaveBeenNthCalledWith(
      1,
      localStream.getTracks()[0],
      expect.objectContaining({ frameMetadata: { timestamp: true } }),
    );
  });

  it("seeds the publisher's start bitrate on every SFU answer once the room is joined", async () => {
    const localStream = createLocalStream();
    const channel = createLiveKitMediaChannel({ localStream, logger });

    await channel.connect({ url: "wss://livekit.example.test", token: "token" });

    const room = liveKitMock.roomInstances[0] as InstanceType<typeof liveKitMock.MockRoom>;
    const answer =
      "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=rtpmap:96 H264/90000\r\na=fmtp:96 packetization-mode=1\r\n";
    await room.engine.pcManager.publisher.setRemoteDescription({ type: "answer", sdp: answer }, 1);
    expect(room.publisherAnswers).toHaveBeenCalledWith(
      { type: "answer", sdp: expect.stringContaining("a=fmtp:96 packetization-mode=1;x-google-start-bitrate=2138") },
      1,
    );

    // VP9 publishes a single layer, so no lower-layer budget is added.
    liveKitMock.roomInstances.length = 0;
    const vp9 = createLiveKitMediaChannel({ localStream: createLocalStream(), logger, videoCodec: "vp9" });
    await vp9.connect({ url: "wss://livekit.example.test", token: "token" });
    const vp9Room = liveKitMock.roomInstances[0] as InstanceType<typeof liveKitMock.MockRoom>;
    await vp9Room.engine.pcManager.publisher.setRemoteDescription({ type: "answer", sdp: answer }, 1);
    expect(vp9Room.publisherAnswers).toHaveBeenCalledWith(
      { type: "answer", sdp: expect.stringContaining("x-google-start-bitrate=1375") },
      1,
    );
  });

  it("fails the media connection if a requested frame-metadata worker cannot be created", async () => {
    const localStream = createLocalStream();
    const channel = createLiveKitMediaChannel({
      localStream,
      createFrameMetadataWorker: () => {
        throw new Error("worker blocked");
      },
    });

    await expect(channel.connect({ url: "wss://livekit.example.test", token: "token" })).rejects.toThrow(
      "worker blocked",
    );
    expect(liveKitMock.roomInstances).toHaveLength(0);
  });

  describe("remote track subscription", () => {
    type MockRoom = InstanceType<typeof liveKitMock.MockRoom>;
    const videoOnlyStream = () => new MediaStream([{ id: "local-video", kind: "video" }] as unknown[]) as MediaStream;

    /** Server already in the room with both tracks when we join, plus a late video publication. */
    const seedServer = (room: MockRoom) => {
      const server = new liveKitMock.MockRemoteParticipant("inference-server-1");
      const audio = new liveKitMock.MockPublication("audio");
      const video = new liveKitMock.MockPublication("video");
      server.trackPublications.set("audio", audio);
      server.trackPublications.set("video", video);
      room.remoteParticipants.set(server.identity, server);
      return { server, audio, video };
    };

    const connectWithServer = async (channel: MediaChannel) => {
      liveKitMock.connectMocks.push(() => {
        seedServer(liveKitMock.roomInstances[0] as MockRoom);
        return Promise.resolve();
      });
      await channel.connect({ url: "wss://livekit.example.test", token: "token" });
      const room = liveKitMock.roomInstances[0] as MockRoom;
      const server = room.remoteParticipants.get("inference-server-1") as InstanceType<
        typeof liveKitMock.MockRemoteParticipant
      >;
      return {
        room,
        server,
        audio: server.trackPublications.get("audio") as InstanceType<typeof liveKitMock.MockPublication>,
        video: server.trackPublications.get("video") as InstanceType<typeof liveKitMock.MockPublication>,
      };
    };

    it("joins without auto-subscribe and subscribes only to the server's video for a video-only client", async () => {
      const channel = createLiveKitMediaChannel({ localStream: videoOnlyStream(), logger });
      const remoteStreams: MediaStream[] = [];
      channel.on("remoteStream", (stream) => remoteStreams.push(stream));

      const { room, server, audio, video } = await connectWithServer(channel);

      expect(room.connect).toHaveBeenCalledWith("wss://livekit.example.test", "token", { autoSubscribe: false });
      expect(video.setSubscribed).toHaveBeenCalledWith(true);
      expect(audio.setSubscribed).not.toHaveBeenCalled();

      // A publication that shows up after the join goes through the same gate.
      const lateAudio = new liveKitMock.MockPublication("audio");
      const lateVideo = new liveKitMock.MockPublication("video");
      room.emit(liveKitMock.RoomEvent.TrackPublished, lateAudio, server);
      room.emit(liveKitMock.RoomEvent.TrackPublished, lateVideo, server);
      expect(lateAudio.setSubscribed).not.toHaveBeenCalled();
      expect(lateVideo.setSubscribed).toHaveBeenCalledWith(true);

      // Even if the SFU hands us an audio track anyway, it never reaches the consumer.
      room.emit(
        liveKitMock.RoomEvent.TrackSubscribed,
        { kind: "audio", mediaStreamTrack: { id: "remote-audio", kind: "audio" } },
        {},
        server,
      );
      expect(remoteStreams).toHaveLength(0);
    });

    it("subscribes to the server's audio when the client publishes audio", async () => {
      const channel = createLiveKitMediaChannel({ localStream: createLocalStream(), logger });
      const { audio, video } = await connectWithServer(channel);
      expect(video.setSubscribed).toHaveBeenCalledWith(true);
      expect(audio.setSubscribed).toHaveBeenCalledWith(true);
    });

    it("subscribes to the server's video only when there is no local stream at all", async () => {
      const channel = createLiveKitMediaChannel({ localStream: null, logger });
      const { audio, video } = await connectWithServer(channel);
      expect(video.setSubscribed).toHaveBeenCalledWith(true);
      expect(audio.setSubscribed).not.toHaveBeenCalled();
    });

    it("re-subscribes after a livekit-internal full reconnect", async () => {
      const channel = createLiveKitMediaChannel({ localStream: videoOnlyStream(), logger });
      const { room, server, audio, video } = await connectWithServer(channel);
      video.setSubscribed.mockClear();

      // A full reconnect lands on a fresh SFU session; publications already known to the
      // Room never re-emit TrackPublished, so the sweep must run again on Reconnected.
      const republished = new liveKitMock.MockPublication("video");
      server.trackPublications.set("video-2", republished);
      room.emit(liveKitMock.RoomEvent.Reconnected);

      expect(video.setSubscribed).toHaveBeenCalledWith(true);
      expect(republished.setSubscribed).toHaveBeenCalledWith(true);
      expect(audio.setSubscribed).not.toHaveBeenCalled();
    });

    it("ignores publications from participants other than the inference server", async () => {
      const channel = createLiveKitMediaChannel({ localStream: createLocalStream(), logger });
      const { room } = await connectWithServer(channel);
      const other = new liveKitMock.MockRemoteParticipant("viewer-1");
      const pub = new liveKitMock.MockPublication("video");
      room.emit(liveKitMock.RoomEvent.TrackPublished, pub, other);
      expect(pub.setSubscribed).not.toHaveBeenCalled();
    });
  });

  it("sends only a lean passthrough join for a bare localStream connect (no set_image bootstrap)", async () => {
    const { StreamSession } = await import("../src/realtime/stream-session.js");
    const localStream = createLocalStream();
    const session = new StreamSession({
      url: "wss://example.test/realtime",
      localStream,
      createMediaChannel: createLiveKitMediaChannel,
    });
    const states: string[] = [];
    const remoteStreams: MediaStream[] = [];
    session.on("connectionChange", (state) => states.push(state));
    session.on("remoteStream", (stream) => remoteStreams.push(stream));

    const leanJoin = { type: "livekit_join", passthrough: true };

    const connectPromise = session.connect();
    const ws = FakeWebSocket.instances[0];
    ws.onopen?.();
    await flushMicrotasks();
    expect(ws.sentMessages).toEqual([leanJoin]);

    sendRoomInfo(ws);
    await flushMicrotasks();
    expect(ws.sentMessages).toEqual([leanJoin]);
    subscribeRemoteTrack();

    const room = liveKitMock.roomInstances[0] as InstanceType<typeof liveKitMock.MockRoom>;
    await expect(connectPromise).resolves.toBeUndefined();
    expect(room.localParticipant.publishTrack).toHaveBeenCalledTimes(2);
    expect(remoteStreams).toHaveLength(1);
    expect(states).toEqual(["connecting", "connected"]);
  });

  it("replaceVideoTrack swaps the published video track without reconnecting", async () => {
    const { StreamSession } = await import("../src/realtime/stream-session.js");
    const localStream = createLocalStream();
    const session = new StreamSession({
      url: "wss://example.test/realtime",
      localStream,
      createMediaChannel: createLiveKitMediaChannel,
    });

    const connectPromise = session.connect();
    const ws = FakeWebSocket.instances[0];
    ws.onopen?.();
    await flushMicrotasks();
    sendRoomInfo(ws);
    await flushMicrotasks();
    subscribeRemoteTrack();
    await expect(connectPromise).resolves.toBeUndefined();

    const room = liveKitMock.roomInstances[0] as InstanceType<typeof liveKitMock.MockRoom>;
    const publication = [...room.localParticipant.videoTrackPublications.values()][0];
    const newTrack = { id: "replacement", kind: "video" } as unknown as MediaStreamTrack;

    await session.replaceVideoTrack(newTrack);

    expect(publication.videoTrack.replaceTrack).toHaveBeenCalledWith(newTrack);
    const stored = (session as unknown as { config: { localStream: MediaStream } }).config.localStream;
    expect(stored.getVideoTracks()[0]).toBe(newTrack);
  });

  it("replaceVideoTrack rejects when not connected", async () => {
    const { StreamSession } = await import("../src/realtime/stream-session.js");
    const session = new StreamSession({
      url: "wss://example.test/realtime",
      localStream: createLocalStream(),
      createMediaChannel: createLiveKitMediaChannel,
    });
    const newTrack = { id: "replacement", kind: "video" } as unknown as MediaStreamTrack;

    await expect(session.replaceVideoTrack(newTrack)).rejects.toThrow(/connection is disconnected/);
  });

  it("emits async errors without retrying when caller initial-state ack fails after connect", async () => {
    const { StreamSession } = await import("../src/realtime/stream-session.js");
    const session = new StreamSession({
      url: "wss://example.test/realtime",
      localStream: null,
      createMediaChannel: createLiveKitMediaChannel,
      initialImage: "base64-image",
    });
    const errors: Error[] = [];
    session.on("error", (error) => errors.push(error));

    const connectPromise = session.connect();
    const firstWs = FakeWebSocket.instances[0];
    firstWs.onopen?.();
    await flushMicrotasks();
    sendRoomInfo(firstWs, "first");
    await flushMicrotasks();

    const firstRoom = liveKitMock.roomInstances[0] as InstanceType<typeof liveKitMock.MockRoom>;
    await expect(connectPromise).resolves.toBeUndefined();

    firstWs.receive({ type: "set_image_ack", success: false, error: "bad image" });

    await vi.waitFor(() => {
      expect(errors).toHaveLength(1);
    });
    expect(errors[0].message).toBe("bad image");
    expect(firstRoom.disconnect).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("does not emit initial-state errors when retry teardown closes a pending ack", async () => {
    vi.useFakeTimers();
    try {
      liveKitMock.connectMocks.push(
        () => Promise.reject(new Error("webrtc failed")),
        () => Promise.resolve(),
      );
      const { StreamSession } = await import("../src/realtime/stream-session.js");
      const session = new StreamSession({
        url: "wss://example.test/realtime",
        localStream: null,
        createMediaChannel: createLiveKitMediaChannel,
        initialPrompt: { text: "wear a hat" },
      });
      const errors: Error[] = [];
      session.on("error", (error) => errors.push(error));

      const connectPromise = session.connect();
      const firstWs = FakeWebSocket.instances[0];
      firstWs.onopen?.();
      await flushMicrotasks();
      sendRoomInfo(firstWs, "first");
      await flushMicrotasks();
      await flushMicrotasks();

      expect(liveKitMock.roomInstances[0]?.disconnect).toHaveBeenCalled();
      expect(errors).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(REALTIME_CONFIG.session.retry.minTimeout);
      await flushMicrotasks();
      expect(FakeWebSocket.instances).toHaveLength(2);

      const secondWs = FakeWebSocket.instances[1];
      secondWs.onopen?.();
      await flushMicrotasks();
      sendRoomInfo(secondWs, "second");

      await expect(connectPromise).resolves.toBeUndefined();
      secondWs.receive({ type: "prompt_ack", prompt: "wear a hat", success: true, error: null });
      await flushMicrotasks();
      expect(errors).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("disconnects media for an already-published track when startup is torn down", async () => {
    const { StreamSession } = await import("../src/realtime/stream-session.js");
    const session = new StreamSession({
      url: "wss://example.test/realtime",
      localStream: createLocalStream(),
      createMediaChannel: createLiveKitMediaChannel,
      initialPrompt: { text: "make it cinematic" },
    });

    const connectPromise = session.connect();
    const firstWs = FakeWebSocket.instances[0];
    firstWs.onopen?.();
    await flushMicrotasks();
    sendRoomInfo(firstWs, "first");
    await flushMicrotasks();

    const firstRoom = liveKitMock.roomInstances[0] as InstanceType<typeof liveKitMock.MockRoom>;
    await expect(connectPromise).resolves.toBeUndefined();
    expect(firstRoom.localParticipant.publishTrack).toHaveBeenCalledTimes(2);

    session.disconnect();
    firstWs.receive({ type: "prompt_ack", prompt: "make it cinematic", success: true, error: null });
    await flushMicrotasks();

    expect(firstRoom.disconnect).toHaveBeenCalled();
  });

  const stubMediaChannel = (): MediaChannel => ({
    localStream: null,
    on: vi.fn(),
    off: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    publishLocalTracks: vi.fn().mockResolvedValue(undefined),
    replaceVideoTrack: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
  });

  /** lucy14b-rt-demo's `isCapacityRefusal`; the SDK's refusal errors must keep matching it. */
  const CAPACITY_REFUSAL = /\b1013\b|at capacity|session limit|concurrent session|try again later/i;

  /** Starts a connect and opens the socket, leaving the join unanswered. */
  const openHandshake = async (
    opts: {
      initialImage?: string;
      connectRetries?: number;
      capacityRetryBudgetMs?: number;
      redialUrl?: () => string | Promise<string>;
    } = {},
  ) => {
    const { StreamSession } = await import("../src/realtime/stream-session.js");
    const session = new StreamSession({
      url: "wss://example.test/realtime",
      localStream: null,
      createMediaChannel: stubMediaChannel,
      ...opts,
    });
    const ended: string[] = [];
    session.on("sessionEnded", (e) => ended.push(e.reason));
    const connectPromise = session.connect();
    connectPromise.catch(() => {});
    const ws = FakeWebSocket.instances.at(-1) as FakeWebSocket;
    ws.onopen?.();
    await flushMicrotasks();
    return { session, ws, ended, connectPromise };
  };

  const connectSession = async (opts: { initialImage?: string; url?: string } = {}) => {
    const { StreamSession } = await import("../src/realtime/stream-session.js");
    const session = new StreamSession({
      url: "wss://example.test/realtime",
      localStream: null,
      createMediaChannel: stubMediaChannel,
      ...opts,
    });
    const connectPromise = session.connect();
    const ws = FakeWebSocket.instances.at(-1) as FakeWebSocket;
    ws.onopen?.();
    await flushMicrotasks();
    sendRoomInfo(ws);
    await connectPromise;
    // "generating" is the state a mid-session close is judged against.
    ws.receive({ type: "generation_started" });
    await flushMicrotasks();
    return { session, ws };
  };

  it("does not reconnect after a terminal generation_ended reason", async () => {
    const { session, ws } = await connectSession();
    const states: string[] = [];
    const ended: string[] = [];
    session.on("connectionChange", (s) => states.push(s));
    session.on("sessionEnded", (e) => ended.push(e.reason));

    ws.receive({ type: "generation_ended", seconds: 12, reason: "moderation_violation" });
    await flushMicrotasks();
    const socketsBefore = FakeWebSocket.instances.length;
    ws.onclose?.({ code: 1000, reason: "" });
    await flushMicrotasks();

    expect(ended).toEqual(["moderation_violation"]);
    expect(states).not.toContain("reconnecting");
    expect(states.at(-1)).toBe("disconnected");
    expect(FakeWebSocket.instances.length).toBe(socketsBefore);
  });

  it("treats a 1008 close as terminal even without a generation_ended reason", async () => {
    const { session, ws } = await connectSession();
    const states: string[] = [];
    const ended: string[] = [];
    session.on("connectionChange", (s) => states.push(s));
    session.on("sessionEnded", (e) => ended.push(e.reason));

    const socketsBefore = FakeWebSocket.instances.length;
    ws.onclose?.({ code: 1008, reason: "" });
    await flushMicrotasks();

    expect(ended).toEqual(["policy_violation"]);
    expect(states).not.toContain("reconnecting");
    expect(FakeWebSocket.instances.length).toBe(socketsBefore);
  });

  it("still reconnects a non-terminal close", async () => {
    const { session, ws } = await connectSession();
    const states: string[] = [];
    session.on("connectionChange", (s) => states.push(s));

    ws.receive({ type: "generation_ended", seconds: 3, reason: "disconnect" });
    await flushMicrotasks();
    ws.onclose?.({ code: 1000, reason: "" });
    await flushMicrotasks();

    expect(states).toContain("reconnecting");
    session.disconnect();
  });

  it("replays the state applied since connect when it reconnects", async () => {
    const { session, ws } = await connectSession();

    const applied = session.setImage({ kind: "data", data: "garment-base64" }, { prompt: "wear this", enhance: false });
    await flushMicrotasks();
    ws.receive({ type: "set_image_ack", success: true, error: null });
    await applied;

    ws.onclose?.({ code: 1000, reason: "" });
    await flushMicrotasks();
    const reconnected = FakeWebSocket.instances.at(-1) as FakeWebSocket;
    expect(reconnected).not.toBe(ws);
    reconnected.onopen?.();
    await flushMicrotasks();

    // The initial state rides its own set_image frame after the join.
    const resent = reconnected.sentMessages.find(
      (m): m is { type: string; image_data?: string | null; prompt?: string | null } =>
        typeof m === "object" && m !== null && (m as { type?: string }).type === "set_image",
    );
    expect(resent).toMatchObject({ image_data: "garment-base64", prompt: "wear this" });

    session.disconnect();
  });

  it("reuses the connect-time URL, including speed=fast, for the reconnected socket", async () => {
    const url = "wss://example.test/realtime?api_key=key&model=lucy-2.5&speed=fast";
    const { session, ws } = await connectSession({ url });
    expect(new URL(ws.url).searchParams.getAll("speed")).toEqual(["fast"]);

    ws.onclose?.({ code: 1000, reason: "" });
    await flushMicrotasks();
    const reconnected = FakeWebSocket.instances.at(-1) as FakeWebSocket;
    expect(reconnected).not.toBe(ws);
    expect(reconnected.url).toBe(ws.url);
    expect(new URL(reconnected.url).searchParams.getAll("speed")).toEqual(["fast"]);
    expect(new URL(reconnected.url).searchParams.get("model")).toBe("lucy-2.5");

    session.disconnect();
  });

  it("keeps the connect-time image when only the prompt is changed", async () => {
    // Regression: a prompt-only update used to drop the connect-time image.
    const { session, ws } = await connectSession({ initialImage: "opening-garment" });

    const applied = session.sendPrompt("now cinematic", { enhance: false });
    await flushMicrotasks();
    ws.receive({ type: "prompt_ack", prompt: "now cinematic", success: true, error: null });
    await applied;

    ws.onclose?.({ code: 1000, reason: "" });
    await flushMicrotasks();
    const reconnected = FakeWebSocket.instances.at(-1) as FakeWebSocket;
    reconnected.onopen?.();
    await flushMicrotasks();

    const resent = reconnected.sentMessages.find(
      (m): m is { type: string; image_data?: string | null; prompt?: string | null } =>
        typeof m === "object" && m !== null && (m as { type?: string }).type === "set_image",
    );
    expect(resent).toMatchObject({ image_data: "opening-garment", prompt: "now cinematic" });

    session.disconnect();
  });

  it("does not retry a 1008 close that lands during the handshake", async () => {
    // Regression: a pre-first-frame kill fell through to pRetry.
    const mediaChannel: MediaChannel = {
      localStream: null,
      on: vi.fn(),
      off: vi.fn(),
      connect: vi.fn().mockResolvedValue(undefined),
      publishLocalTracks: vi.fn().mockResolvedValue(undefined),
      replaceVideoTrack: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
    };
    const { StreamSession } = await import("../src/realtime/stream-session.js");
    const session = new StreamSession({
      url: "wss://example.test/realtime",
      localStream: null,
      initialImage: "refused-garment",
      createMediaChannel: () => mediaChannel,
    });
    const ended: string[] = [];
    session.on("sessionEnded", (e) => ended.push(e.reason));

    const connectPromise = session.connect();
    const ws = FakeWebSocket.instances.at(-1) as FakeWebSocket;
    ws.onopen?.();
    await flushMicrotasks();
    // Before the state ever reaches "connected".
    ws.onclose?.({ code: 1008, reason: "" });
    await expect(connectPromise).rejects.toThrow();

    expect(ended).toEqual(["policy_violation"]);
    // One socket only: no retry re-sent the refused garment.
    expect(FakeWebSocket.instances.length).toBe(1);
  });

  it("reports a policy close during the reconnect handshake as a session end", async () => {
    // Regression: this path emitted a generic error instead of sessionEnded.
    const { session, ws } = await connectSession({ initialImage: "restored-garment" });
    const ended: string[] = [];
    const errors: string[] = [];
    session.on("sessionEnded", (e) => ended.push(e.reason));
    session.on("error", (e) => errors.push(e.message));

    ws.onclose?.({ code: 1000, reason: "" });
    await flushMicrotasks();
    const reconnecting = FakeWebSocket.instances.at(-1) as FakeWebSocket;
    expect(reconnecting).not.toBe(ws);
    // Before room_info, so SignalingChannel rejects rather than emitting "closed".
    reconnecting.onclose?.({ code: 1008, reason: "" });
    // pRetry's rejection needs more than a microtask flush.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(ended).toEqual(["policy_violation"]);
    expect(errors).toEqual([]);
  });

  it("does not retry the server's session-limit refusal during the handshake", async () => {
    // The server sends an `error` message, then closes 1013 "Session Limit Reached". Each
    // retry would be a fresh dial that takes a freed slot ahead of the app's own queue.
    const { session, ws, ended, connectPromise } = await openHandshake({ initialImage: "queued-garment" });

    ws.receive({ type: "error", error: "Concurrent session limit reached." });
    const error = await connectPromise.catch((e: Error) => e);
    // The close lands a tick later, as it does in a browser.
    ws.onclose?.({ code: 1013, reason: "Session Limit Reached" });
    await flushMicrotasks();

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Concurrent session limit reached.");
    expect((error as Error).message).toMatch(CAPACITY_REFUSAL);
    expect(ended).toEqual(["session_limit"]);
    expect(session.getConnectionState()).toBe("disconnected");
    // One socket only: no retry re-sent the garment or took someone else's slot.
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("treats a bare 1013 Session Limit Reached close during the handshake as terminal", async () => {
    const { ws, ended, connectPromise } = await openHandshake();

    ws.onclose?.({ code: 1013, reason: "Session Limit Reached" });
    const error = await connectPromise.catch((e: Error) => e);

    expect((error as Error).message).toBe("WebSocket closed: 1013 Session Limit Reached");
    expect((error as Error).message).toMatch(CAPACITY_REFUSAL);
    expect(ended).toEqual(["session_limit"]);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("still retries a 1013 Try Again Later close during the handshake", async () => {
    // Upstream capacity is transient; the next dial may well succeed.
    vi.useFakeTimers();
    const { session, ws, ended, connectPromise } = await openHandshake();

    ws.onclose?.({ code: 1013, reason: "Try Again Later" });
    await flushMicrotasks();
    expect(FakeWebSocket.instances).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(REALTIME_CONFIG.session.retry.minTimeout);
    expect(FakeWebSocket.instances).toHaveLength(2);
    const retried = FakeWebSocket.instances[1];
    retried.onopen?.();
    await flushMicrotasks();
    sendRoomInfo(retried);
    await expect(connectPromise).resolves.toBeUndefined();

    expect(ended).toEqual([]);
    session.disconnect();
  });

  it("retries a redial whose credential source failed transiently, whatever it rejected with", async () => {
    vi.useFakeTimers();
    const { retry } = REALTIME_CONFIG.session;
    const redialUrl = vi
      .fn<() => Promise<string>>()
      // A plain SDK error (e.g. a failed mint behind the provider), then a bare string.
      .mockRejectedValueOnce({ code: "TOKEN_CREATE_ERROR", message: "Failed to create token: 503" })
      .mockRejectedValueOnce("token endpoint down")
      .mockResolvedValue("wss://example.test/realtime?api_key=fresh");
    const { session, ws, ended, connectPromise } = await openHandshake({ redialUrl });

    ws.onclose?.({ code: 1013, reason: "Try Again Later" });
    await vi.advanceTimersByTimeAsync(retry.minTimeout);
    expect(redialUrl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(retry.minTimeout * retry.factor);
    expect(redialUrl).toHaveBeenCalledTimes(2);
    expect(FakeWebSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(retry.minTimeout * retry.factor ** 2);
    expect(redialUrl).toHaveBeenCalledTimes(3);
    expect(FakeWebSocket.instances).toHaveLength(2);

    const retried = FakeWebSocket.instances[1];
    expect(retried.url).toContain("api_key=fresh");
    retried.onopen?.();
    await flushMicrotasks();
    sendRoomInfo(retried);
    await expect(connectPromise).resolves.toBeUndefined();
    expect(ended).toEqual([]);
    session.disconnect();
  });

  it("does not retry a redial the SDK refused outright, such as an expired client token", async () => {
    vi.useFakeTimers();
    const redialUrl = vi.fn<() => Promise<string>>().mockRejectedValue({
      code: "TOKEN_EXPIRED",
      message: "Client token expired 10 s ago",
    });
    const { session, ws, ended, connectPromise } = await openHandshake({ redialUrl });

    ws.onclose?.({ code: 1013, reason: "Try Again Later" });
    await vi.advanceTimersByTimeAsync(REALTIME_CONFIG.session.retry.minTimeout);
    await expect(connectPromise).rejects.toMatchObject({ sdkError: { code: "TOKEN_EXPIRED" } });
    await vi.advanceTimersByTimeAsync(REALTIME_CONFIG.session.retry.maxTimeout);

    expect(redialUrl).toHaveBeenCalledTimes(1);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(ended).toEqual([]);
    expect(session.getConnectionState()).toBe("disconnected");
  });

  it("connectRetries: 0 rejects a transient handshake failure after a single dial", async () => {
    vi.useFakeTimers();
    const { session, ws, ended, connectPromise } = await openHandshake({ connectRetries: 0 });

    ws.onclose?.({ code: 1013, reason: "Try Again Later" });
    await expect(connectPromise).rejects.toThrow("WebSocket closed: 1013 Try Again Later");
    await vi.advanceTimersByTimeAsync(REALTIME_CONFIG.session.retry.maxTimeout);

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(ended).toEqual([]);
    expect(session.getConnectionState()).toBe("disconnected");
  });

  it("ends an established session on a 1013 Session Limit Reached close without reconnecting", async () => {
    const { session, ws } = await connectSession();
    const states: string[] = [];
    const ended: string[] = [];
    session.on("connectionChange", (s) => states.push(s));
    session.on("sessionEnded", (e) => ended.push(e.reason));

    const socketsBefore = FakeWebSocket.instances.length;
    ws.onclose?.({ code: 1013, reason: "Session Limit Reached" });
    await flushMicrotasks();

    expect(ended).toEqual(["session_limit"]);
    expect(states).not.toContain("reconnecting");
    expect(states.at(-1)).toBe("disconnected");
    expect(FakeWebSocket.instances.length).toBe(socketsBefore);
  });

  it("still reconnects an established session after a 1013 Try Again Later close", async () => {
    const { session, ws } = await connectSession();
    const states: string[] = [];
    session.on("connectionChange", (s) => states.push(s));

    const socketsBefore = FakeWebSocket.instances.length;
    ws.onclose?.({ code: 1013, reason: "Try Again Later" });
    await flushMicrotasks();

    expect(states).toContain("reconnecting");
    expect(FakeWebSocket.instances.length).toBe(socketsBefore + 1);
    session.disconnect();
  });

  describe("capacity refusals (error_type: capacity, retry_after)", () => {
    const CAPACITY_ERROR = "Server at capacity. Please try again later.";

    /** The server's capacity refusal: a typed `error` message, then the 1013 close a tick later. */
    const refuseForCapacity = async (ws: FakeWebSocket, retryAfter = 5) => {
      ws.receive({ type: "error", error: CAPACITY_ERROR, error_type: "capacity", retry_after: retryAfter });
      await vi.advanceTimersByTimeAsync(0);
      ws.onclose?.({ code: 1013, reason: "Try Again Later" });
      await vi.advanceTimersByTimeAsync(0);
    };

    beforeEach(() => vi.useFakeTimers());

    it("re-dials after retry_after (±20 % jitter) instead of the backoff, and emits capacityWait", async () => {
      const { session, ws, ended, connectPromise } = await openHandshake();
      const waits: CapacityWait[] = [];
      session.on("capacityWait", (wait) => waits.push(wait));

      await refuseForCapacity(ws, 5);
      expect(waits).toHaveLength(1);
      expect(waits[0].attempt).toBe(1);
      expect(waits[0].retryAfterMs).toBeGreaterThanOrEqual(4000);
      expect(waits[0].retryAfterMs).toBeLessThanOrEqual(6000);
      // Well past the 1 s backoff floor, still waiting for the server's delay.
      await vi.advanceTimersByTimeAsync(3999);
      expect(FakeWebSocket.instances).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(waits[0].retryAfterMs - 3999);
      expect(FakeWebSocket.instances).toHaveLength(2);

      const retried = FakeWebSocket.instances[1];
      retried.onopen?.();
      await flushMicrotasks();
      sendRoomInfo(retried);
      await expect(connectPromise).resolves.toBeUndefined();
      expect(waits).toHaveLength(1);
      expect(ended).toEqual([]);
      session.disconnect();
    });

    it("stops once the next wait would end past capacityRetryBudgetMs and rejects with the server's error", async () => {
      const { session, ws, ended, connectPromise } = await openHandshake({ capacityRetryBudgetMs: 7_000 });

      await refuseForCapacity(ws, 5); // the first wait (4 to 6 s) fits the budget
      await vi.advanceTimersByTimeAsync(6000);
      const retried = FakeWebSocket.instances[1];
      retried.onopen?.();
      await flushMicrotasks();
      await refuseForCapacity(retried, 5); // a second wait would end past 7 s

      const error = await connectPromise.catch((e: Error) => e);
      expect(error).toMatchObject({ message: CAPACITY_ERROR, errorType: "capacity", retryAfter: 5 });
      expect((error as Error).message).toMatch(CAPACITY_REFUSAL);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(FakeWebSocket.instances).toHaveLength(2);
      expect(ended).toEqual([]);
      expect(session.getConnectionState()).toBe("disconnected");
    });

    it("connectRetries: 0 dials once, whatever retry_after says", async () => {
      const { session, ws, connectPromise } = await openHandshake({ connectRetries: 0 });
      const waits: CapacityWait[] = [];
      session.on("capacityWait", (wait) => waits.push(wait));

      await refuseForCapacity(ws, 5);
      await expect(connectPromise).rejects.toThrow(CAPACITY_ERROR);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(FakeWebSocket.instances).toHaveLength(1);
      expect(waits).toEqual([]);
      expect(session.getConnectionState()).toBe("disconnected");
    });
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
