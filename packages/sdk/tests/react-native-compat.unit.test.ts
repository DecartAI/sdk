import type * as LiveKitClient from "livekit-client";
import { afterEach, describe, expect, it, vi } from "vitest";

const liveKitMockState = vi.hoisted(() => ({
  evaluations: 0,
  rooms: [] as Array<{
    state: string;
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    publishTrack: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("livekit-client", () => {
  liveKitMockState.evaluations++;
  class Room {
    state = "disconnected";
    readonly connect = vi.fn(async () => {
      this.state = "connected";
    });
    readonly disconnect = vi.fn(async () => {
      this.state = "disconnected";
    });
    readonly publishTrack = vi.fn(async () => ({}));
    readonly localParticipant = {
      publishTrack: this.publishTrack,
      videoTrackPublications: new Map(),
    };

    constructor() {
      liveKitMockState.rooms.push(this);
    }

    on() {
      return this;
    }
  }
  return {
    Room,
    RoomEvent: {
      TrackSubscribed: "trackSubscribed",
      Disconnected: "disconnected",
      ConnectionStateChanged: "connectionStateChanged",
    },
    Track: { Kind: { Video: "video", Audio: "audio" }, Source: { Camera: "camera" } },
    ConnectionState: {
      Connecting: "connecting",
      Connected: "connected",
      Reconnecting: "reconnecting",
      SignalReconnecting: "signalReconnecting",
      Disconnected: "disconnected",
    },
  };
});

const reactNativeGlobals = [
  "LiveKitReactNativeGlobal",
  "RTCPeerConnection",
  "MediaStream",
  "MediaStreamTrack",
  "DOMException",
  "ReadableStream",
  "WritableStream",
  "TransformStream",
  "URL",
  "URLSearchParams",
] as const;

function stubReactNative(setupComplete: boolean): void {
  vi.stubGlobal("navigator", { product: "ReactNative", userAgent: "ReactNative" });
  if (!setupComplete) return;
  for (const name of reactNativeGlobals) {
    const existing = (globalThis as unknown as Record<string, unknown>)[name];
    vi.stubGlobal(name, name === "LiveKitReactNativeGlobal" ? { platform: "ios" } : (existing ?? class {}));
  }
}

describe("React Native compatibility", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("imports the SDK without browser constructors and without loading LiveKit", async () => {
    liveKitMockState.evaluations = 0;
    for (const name of ["File", "Blob", "ReadableStream", "WritableStream", "TransformStream", "DOMException"]) {
      vi.stubGlobal(name, undefined);
    }

    const sdk = await import("../src/index.js");
    expect(sdk.models.realtime("lucy-2.5").name).toBe("lucy-2.5");
    expect(() => sdk.createDecartClient({ apiKey: "test" })).not.toThrow();
    expect(liveKitMockState.evaluations).toBe(0);
  });

  it("accepts React Native file objects when browser constructors are absent", async () => {
    for (const name of ["File", "Blob", "ReadableStream"]) vi.stubGlobal(name, undefined);
    const { fileInputToBlob } = await import("../src/shared/request.js");
    const file = { uri: "file:///tmp/image.png", type: "image/png", name: "image.png" };
    await expect(fileInputToBlob(file)).resolves.toBe(file);
  });

  it("fails before loading LiveKit when registerGlobals was not called", async () => {
    liveKitMockState.evaluations = 0;
    stubReactNative(false);
    const { createDecartClient, models, ERROR_CODES } = await import("../src/index.react-native.js");
    const client = createDecartClient({ apiKey: "test" });

    await expect(
      client.realtime.connect(null, { model: models.realtime("lucy-2.5"), onRemoteStream: () => {} }),
    ).rejects.toMatchObject({
      code: ERROR_CODES.REACT_NATIVE_SETUP_REQUIRED,
    });
    expect(liveKitMockState.evaluations).toBe(0);
  });

  it.each([
    ["mirror", { mirror: true }],
    ["debugQuality", { debugQuality: true }],
  ])("rejects unsupported %s sessions", async (_feature, unsupportedOption) => {
    stubReactNative(true);
    const { createDecartClient, models, ERROR_CODES } = await import("../src/index.react-native.js");
    const client = createDecartClient({ apiKey: "test" });

    await expect(
      client.realtime.connect(null, {
        model: models.realtime("lucy-2.5"),
        onRemoteStream: () => {},
        ...unsupportedOption,
      }),
    ).rejects.toMatchObject({ code: ERROR_CODES.UNSUPPORTED_PLATFORM_FEATURE });
  });

  it("rejects deep preflight on React Native", async () => {
    stubReactNative(true);
    const { createDecartClient, models, ERROR_CODES } = await import("../src/index.react-native.js");
    const client = createDecartClient({ apiKey: "test" });
    await expect(
      client.realtime.checkConnectivity({ deep: true, model: models.realtime("lucy-2.5") }),
    ).rejects.toMatchObject({ code: ERROR_CODES.UNSUPPORTED_PLATFORM_FEATURE });
  });

  it("reports malformed LiveKit module exports", async () => {
    const { validateLiveKitModule } = await import("../src/realtime/livekit.js");
    expect(() => validateLiveKitModule({} as typeof LiveKitClient)).toThrow();
    try {
      validateLiveKitModule({} as typeof LiveKitClient);
    } catch (error) {
      expect(error).toMatchObject({ code: "LIVEKIT_INITIALIZATION_ERROR" });
    }
  });

  it("builds VP8 publish options", async () => {
    const { getDefaultVideoPublishOptions } = await import("../src/realtime/media-channel.js");
    expect(getDefaultVideoPublishOptions("vp8")).toMatchObject({
      source: "camera",
      videoCodec: "vp8",
      simulcast: true,
    });
  });

  it("initializes mocked React Native publish and subscribe sessions", async () => {
    stubReactNative(true);
    liveKitMockState.rooms.length = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ livekit_url: "wss://livekit.test", token: "watch-token", room_name: "room-1" }),
      ),
    );

    const [{ LiveKitMediaChannel }, { createRealTimeSubscribeClient }, { createConsoleLogger }] = await Promise.all([
      import("../src/realtime/media-channel.js"),
      import("../src/realtime/subscribe-client.js"),
      import("../src/utils/logger.js"),
    ]);
    const videoTrack = { kind: "video" } as MediaStreamTrack;
    const localStream = { getTracks: () => [videoTrack] } as MediaStream;
    const mediaChannel = new LiveKitMediaChannel({ localStream, videoCodec: "vp8" });

    await mediaChannel.connect({ url: "wss://livekit.test", token: "publish-token" });
    await mediaChannel.publishLocalTracks();
    expect(liveKitMockState.rooms[0]?.connect).toHaveBeenCalledWith("wss://livekit.test", "publish-token");
    expect(liveKitMockState.rooms[0]?.publishTrack).toHaveBeenCalledWith(
      videoTrack,
      expect.objectContaining({ videoCodec: "vp8" }),
    );

    const subscriber = createRealTimeSubscribeClient({
      baseUrl: "https://api.test",
      apiKey: "test",
      logger: createConsoleLogger("error"),
    });
    const subscription = await subscriber.subscribe({
      token: btoa(JSON.stringify({ room_name: "room-1" })),
      onRemoteStream: () => {},
    });
    expect(subscription.isConnected()).toBe(true);
    expect(liveKitMockState.rooms[1]?.connect).toHaveBeenCalledWith("wss://livekit.test", "watch-token");
    subscription.disconnect();
  });
});
