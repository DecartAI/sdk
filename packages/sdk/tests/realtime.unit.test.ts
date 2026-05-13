import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { models } from "../src/index.js";

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
      expect(lucyModel.fps).toBe(20);
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
    expect(mockSession.sendPrompt).toHaveBeenCalledWith("a cat", { enhance: false, timeout: 15000 });
  });

  it("setPrompt defaults enhance to true", async () => {
    await methods.setPrompt("a cat");
    expect(mockSession.sendPrompt).toHaveBeenCalledWith("a cat", { enhance: true, timeout: 15000 });
  });

  it("setPrompt propagates session rejections", async () => {
    mockSession.sendPrompt.mockRejectedValue(new Error("invalid prompt"));
    await expect(methods.setPrompt("a cat")).rejects.toThrow("invalid prompt");
  });

  it("sends only prompt when no image provided", async () => {
    await methods.set({ prompt: "a cat" });
    expect(mockSession.setImage).toHaveBeenCalledWith(null, { prompt: "a cat", enhance: true, timeout: 30000 });
  });

  it("sends prompt with enhance flag", async () => {
    await methods.set({ prompt: "a cat", enhance: true });
    expect(mockSession.setImage).toHaveBeenCalledWith(null, { prompt: "a cat", enhance: true, timeout: 30000 });
  });

  it("sends only image when no prompt provided", async () => {
    mockImageToBase64.mockResolvedValue("convertedbase64");
    await methods.set({ image: "rawbase64data" });

    expect(mockImageToBase64).toHaveBeenCalledWith("rawbase64data");
    expect(mockSession.setImage).toHaveBeenCalledWith("convertedbase64", {
      prompt: undefined,
      enhance: true,
      timeout: 30000,
    });
  });

  it("sends prompt and image together", async () => {
    mockImageToBase64.mockResolvedValue("convertedbase64");
    await methods.set({ prompt: "a cat", enhance: false, image: "rawbase64" });

    expect(mockSession.setImage).toHaveBeenCalledWith("convertedbase64", {
      prompt: "a cat",
      enhance: false,
      timeout: 30000,
    });
  });

  it("converts Blob image to base64", async () => {
    mockImageToBase64.mockResolvedValue("blobbase64");
    const testBlob = new Blob(["test-image"], { type: "image/png" });
    await methods.set({ image: testBlob });

    expect(mockImageToBase64).toHaveBeenCalledWith(testBlob);
    expect(mockSession.setImage).toHaveBeenCalledWith("blobbase64", {
      prompt: undefined,
      enhance: true,
      timeout: 30000,
    });
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

describe("SignalingChannel initial handshake", () => {
  class FakeWebSocket {
    static OPEN = 1;

    static instances: FakeWebSocket[] = [];

    readyState = FakeWebSocket.OPEN;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: ((event: { code: number; reason: string }) => void) | null = null;
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

  it("waits for the initial set_image ack before resolving the handshake", async () => {
    const { SignalingChannel } = await import("../src/realtime/signaling-channel.js");
    const channel = new SignalingChannel({ url: "wss://example.test/realtime" });

    const connectPromise = channel.connect({
      initialState: { image: "base64-image", prompt: "wear a hat", enhance: false },
    });

    const ws = FakeWebSocket.instances[0];
    ws.onopen?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(ws.sentMessages).toEqual([
      { type: "livekit_join" },
      { type: "set_image", image_data: "base64-image", prompt: "wear a hat", enhance_prompt: false },
    ]);

    let resolved = false;
    connectPromise.then(() => {
      resolved = true;
    });

    ws.receive({
      type: "livekit_room_info",
      livekit_url: "wss://livekit.example.test",
      token: "token",
      room_name: "room",
      session_id: "session",
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    ws.receive({ type: "set_image_ack", success: true, error: null });
    await expect(connectPromise).resolves.toBeUndefined();
    expect(resolved).toBe(true);
  });

  it("waits for the initial null set_image ack before resolving the handshake", async () => {
    const { SignalingChannel } = await import("../src/realtime/signaling-channel.js");
    const channel = new SignalingChannel({ url: "wss://example.test/realtime" });

    const connectPromise = channel.connect({
      initialState: { image: null, prompt: null },
    });

    const ws = FakeWebSocket.instances[0];
    ws.onopen?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(ws.sentMessages).toEqual([{ type: "livekit_join" }, { type: "set_image", image_data: null, prompt: null }]);

    let resolved = false;
    connectPromise.then(() => {
      resolved = true;
    });

    ws.receive({
      type: "livekit_room_info",
      livekit_url: "wss://livekit.example.test",
      token: "token",
      room_name: "room",
      session_id: "session",
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    ws.receive({ type: "set_image_ack", success: true, error: null });
    await expect(connectPromise).resolves.toBeUndefined();
    expect(resolved).toBe(true);
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
    const error = new Error("Insufficient credits") as Error & { source?: string };
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
    const result = createWebrtcTimeoutError("webrtc-handshake", 30000);
    expect(result.code).toBe(ERROR_CODES.WEBRTC_TIMEOUT_ERROR);
    expect(result.message).toBe("webrtc-handshake timed out after 30000ms");
    expect(result.data).toEqual({ phase: "webrtc-handshake", timeoutMs: 30000 });
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
