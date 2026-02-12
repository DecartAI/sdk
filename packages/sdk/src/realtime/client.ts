import { z } from "zod";
import { modelDefinitionSchema } from "../shared/model";
import { modelStateSchema } from "../shared/types";
import { createWebrtcError, type DecartSDKError } from "../utils/errors";
import { AudioStreamManager } from "./audio-stream-manager";
import { createEventBuffer } from "./event-buffer";
import { realtimeMethods, type SetInput } from "./methods";
import {
  decodeSubscribeToken,
  encodeSubscribeToken,
  type RealTimeSubscribeClient,
  type SubscribeEvents,
  type SubscribeOptions,
} from "./subscribe-client";
import type { ConnectionState, GenerationTickMessage, SessionIdMessage } from "./types";
import { WebRTCManager } from "./webrtc-manager";

async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("FileReader did not return a string"));
        return;
      }
      const base64 = result.split(",")[1];
      if (!base64) {
        reject(new Error("Invalid data URL format"));
        return;
      }
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function imageToBase64(image: Blob | File | string): Promise<string> {
  if (typeof image === "string") {
    let url: URL | null = null;
    try {
      url = new URL(image);
    } catch {
      // Not a valid URL, treat as raw base64
    }

    if (url?.protocol === "data:") {
      const [, base64] = image.split(",", 2);
      if (!base64) {
        throw new Error("Invalid data URL image");
      }
      return base64;
    }
    if (url?.protocol === "http:" || url?.protocol === "https:") {
      const response = await fetch(image);
      if (!response.ok) {
        throw new Error(`Failed to fetch image: ${response.status} ${response.statusText}`);
      }
      const imageBlob = await response.blob();
      return blobToBase64(imageBlob);
    }
    return image;
  }
  return blobToBase64(image);
}

export type RealTimeClientOptions = {
  baseUrl: string;
  apiKey: string;
  integration?: string;
};

const realTimeClientInitialStateSchema = modelStateSchema;
type OnRemoteStreamFn = (stream: MediaStream) => void;
export type RealTimeClientInitialState = z.infer<typeof realTimeClientInitialStateSchema>;

// ugly workaround to add an optional function to the schema
// https://github.com/colinhacks/zod/issues/4143#issuecomment-2845134912
const createAsyncFunctionSchema = <T extends z.core.$ZodFunction>(schema: T) =>
  z.custom<Parameters<T["implementAsync"]>[0]>((fn) => schema.implementAsync(fn as Parameters<T["implementAsync"]>[0]));

const avatarOptionsSchema = z.object({
  avatarImage: z.union([z.instanceof(Blob), z.instanceof(File), z.string()]),
});
export type AvatarOptions = z.infer<typeof avatarOptionsSchema>;

const realTimeClientConnectOptionsSchema = z.object({
  model: modelDefinitionSchema,
  onRemoteStream: z.custom<OnRemoteStreamFn>((val) => typeof val === "function", {
    message: "onRemoteStream must be a function",
  }),
  initialState: realTimeClientInitialStateSchema.optional(),
  customizeOffer: createAsyncFunctionSchema(z.function()).optional(),
  avatar: avatarOptionsSchema.optional(),
});
export type RealTimeClientConnectOptions = z.infer<typeof realTimeClientConnectOptionsSchema>;

export type Events = {
  connectionChange: ConnectionState;
  error: DecartSDKError;
  generationTick: { seconds: number };
};

export type RealTimeClient = {
  set: (input: SetInput) => Promise<void>;
  setPrompt: (prompt: string, { enhance }?: { enhance?: boolean }) => Promise<void>;
  isConnected: () => boolean;
  getConnectionState: () => ConnectionState;
  disconnect: () => void;
  on: <K extends keyof Events>(event: K, listener: (data: Events[K]) => void) => void;
  off: <K extends keyof Events>(event: K, listener: (data: Events[K]) => void) => void;
  sessionId: string | null;
  subscribeToken: string | null;
  setImage: (
    image: Blob | File | string | null,
    options?: { prompt?: string; enhance?: boolean; timeout?: number },
  ) => Promise<void>;
  playAudio?: (audio: Blob | File | ArrayBuffer) => Promise<void>;
};

export const createRealTimeClient = (opts: RealTimeClientOptions) => {
  const { baseUrl, apiKey, integration } = opts;

  const connect = async (
    stream: MediaStream | null,
    options: RealTimeClientConnectOptions,
  ): Promise<RealTimeClient> => {
    const parsedOptions = realTimeClientConnectOptionsSchema.safeParse(options);
    if (!parsedOptions.success) {
      throw parsedOptions.error;
    }

    const isAvatarLive = options.model.name === "live_avatar";

    const { onRemoteStream, initialState, avatar } = parsedOptions.data;

    // For live_avatar without user-provided stream: create AudioStreamManager for continuous silent stream with audio injection
    // If user provides their own stream (e.g., mic input), use it directly
    let audioStreamManager: AudioStreamManager | undefined;
    let inputStream: MediaStream;

    if (isAvatarLive && !stream) {
      audioStreamManager = new AudioStreamManager();
      inputStream = audioStreamManager.getStream();
    } else {
      inputStream = stream ?? new MediaStream();
    }

    let webrtcManager: WebRTCManager | undefined;

    try {
      // For live_avatar: prepare avatar image base64 before connection
      let avatarImageBase64: string | undefined;
      if (isAvatarLive && avatar?.avatarImage) {
        if (typeof avatar.avatarImage === "string") {
          const response = await fetch(avatar.avatarImage);
          if (!response.ok) {
            throw new Error(`Failed to fetch image: ${response.status} ${response.statusText}`);
          }
          const imageBlob = await response.blob();
          avatarImageBase64 = await blobToBase64(imageBlob);
        } else {
          avatarImageBase64 = await blobToBase64(avatar.avatarImage);
        }
      }

      // For live_avatar: prepare initial prompt to send before WebRTC handshake
      const initialPrompt =
        isAvatarLive && initialState?.prompt
          ? { text: initialState.prompt.text, enhance: initialState.prompt.enhance }
          : undefined;

      const url = `${baseUrl}${options.model.urlPath}`;

      const { emitter: eventEmitter, emitOrBuffer, flush, stop } = createEventBuffer<Events>();

      webrtcManager = new WebRTCManager({
        webrtcUrl: `${url}?api_key=${encodeURIComponent(apiKey)}&model=${encodeURIComponent(options.model.name)}`,
        integration,
        onRemoteStream,
        onConnectionStateChange: (state) => {
          emitOrBuffer("connectionChange", state);
        },
        onError: (error) => {
          console.error("WebRTC error:", error);
          emitOrBuffer("error", createWebrtcError(error));
        },
        customizeOffer: options.customizeOffer as ((offer: RTCSessionDescriptionInit) => Promise<void>) | undefined,
        vp8MinBitrate: 300,
        vp8StartBitrate: 600,
        isAvatarLive,
        avatarImageBase64,
        initialPrompt,
      });

      const manager = webrtcManager;

      let sessionId: string | null = null;
      let subscribeToken: string | null = null;
      const sessionIdListener = (msg: SessionIdMessage) => {
        subscribeToken = encodeSubscribeToken(msg.session_id, msg.server_ip, msg.server_port);
        sessionId = msg.session_id;
      };
      manager.getWebsocketMessageEmitter().on("sessionId", sessionIdListener);

      const tickListener = (msg: GenerationTickMessage) => {
        emitOrBuffer("generationTick", { seconds: msg.seconds });
      };
      manager.getWebsocketMessageEmitter().on("generationTick", tickListener);

      await manager.connect(inputStream);

      const methods = realtimeMethods(manager, imageToBase64);

      // For non-live_avatar models: send initial prompt after connection is established
      if (!isAvatarLive && initialState?.prompt) {
        const { text, enhance } = initialState.prompt;
        await methods.setPrompt(text, { enhance });
      }

      const client: RealTimeClient = {
        set: methods.set,
        setPrompt: methods.setPrompt,
        isConnected: () => manager.isConnected(),
        getConnectionState: () => manager.getConnectionState(),
        disconnect: () => {
          stop();
          manager.cleanup();
          audioStreamManager?.cleanup();
        },
        on: eventEmitter.on,
        off: eventEmitter.off,
        get sessionId() {
          return sessionId;
        },
        get subscribeToken() {
          return subscribeToken;
        },
        setImage: async (
          image: Blob | File | string | null,
          options?: { prompt?: string; enhance?: boolean; timeout?: number },
        ) => {
          if (image === null) {
            return manager.setImage(null, options);
          }
          const base64 = await imageToBase64(image);
          return manager.setImage(base64, options);
        },
      };

      // Add live_avatar specific audio method (only when using internal AudioStreamManager)
      if (isAvatarLive && audioStreamManager) {
        const manager = audioStreamManager; // Capture for closures
        client.playAudio = (audio: Blob | File | ArrayBuffer) => manager.playAudio(audio);
      }

      flush();
      return client;
    } catch (error) {
      webrtcManager?.cleanup();
      audioStreamManager?.cleanup();
      throw error;
    }
  };

  const subscribe = async (options: SubscribeOptions): Promise<RealTimeSubscribeClient> => {
    const { sid, ip, port } = decodeSubscribeToken(options.token);
    const subscribeUrl = `${baseUrl}/subscribe/${encodeURIComponent(sid)}?IP=${encodeURIComponent(ip)}&port=${encodeURIComponent(port)}&api_key=${encodeURIComponent(apiKey)}`;

    const { emitter: eventEmitter, emitOrBuffer, flush, stop } = createEventBuffer<SubscribeEvents>();

    let webrtcManager: WebRTCManager | undefined;

    try {
      webrtcManager = new WebRTCManager({
        webrtcUrl: subscribeUrl,
        integration,
        onRemoteStream: options.onRemoteStream,
        onConnectionStateChange: (state) => {
          emitOrBuffer("connectionChange", state);
        },
        onError: (error) => {
          console.error("WebRTC subscribe error:", error);
          emitOrBuffer("error", createWebrtcError(error));
        },
      });

      const manager = webrtcManager;
      await manager.connect(null);

      const client: RealTimeSubscribeClient = {
        isConnected: () => manager.isConnected(),
        getConnectionState: () => manager.getConnectionState(),
        disconnect: () => {
          stop();
          manager.cleanup();
        },
        on: eventEmitter.on,
        off: eventEmitter.off,
      };

      flush();
      return client;
    } catch (error) {
      webrtcManager?.cleanup();
      throw error;
    }
  };

  return {
    connect,
    subscribe,
  };
};
