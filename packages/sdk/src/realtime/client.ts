import mitt from "mitt";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { modelDefinitionSchema } from "../shared/model";
import { modelStateSchema } from "../shared/types";
import { createWebrtcError, type DecartSDKError } from "../utils/errors";
import { AudioStreamManager } from "./audio-stream-manager";
import { realtimeMethods } from "./methods";
import { WebRTCManager } from "./webrtc-manager";

async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      // Remove data URL prefix (e.g., "data:image/png;base64,")
      const base64 = result.split(",")[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
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

type OnStatusFn = (status: string) => void;
type OnQueuePositionFn = (data: { position: number; queueSize: number }) => void;

const realTimeClientConnectOptionsSchema = z.object({
  model: modelDefinitionSchema,
  onRemoteStream: z.custom<OnRemoteStreamFn>((val) => typeof val === "function", {
    message: "onRemoteStream must be a function",
  }),
  initialState: realTimeClientInitialStateSchema.optional(),
  customizeOffer: createAsyncFunctionSchema(z.function()).optional(),
  avatar: avatarOptionsSchema.optional(),
  onStatus: z
    .custom<OnStatusFn>((val) => typeof val === "function", {
      message: "onStatus must be a function",
    })
    .optional(),
  onQueuePosition: z
    .custom<OnQueuePositionFn>((val) => typeof val === "function", {
      message: "onQueuePosition must be a function",
    })
    .optional(),
});
export type RealTimeClientConnectOptions = z.infer<typeof realTimeClientConnectOptionsSchema>;

export type Events = {
  connectionChange: "connected" | "connecting" | "disconnected";
  error: DecartSDKError;
  status: string;
  queuePosition: { position: number; queueSize: number };
};

export type RealTimeClient = {
  setPrompt: (prompt: string, { enhance }?: { enhance?: boolean }) => Promise<void>;
  isConnected: () => boolean;
  getConnectionState: () => "connected" | "connecting" | "disconnected";
  disconnect: () => void;
  on: <K extends keyof Events>(event: K, listener: (data: Events[K]) => void) => void;
  off: <K extends keyof Events>(event: K, listener: (data: Events[K]) => void) => void;
  sessionId: string;
  setImage: (
    image: Blob | File | string | null,
    options?: { prompt?: string; enhance?: boolean; timeout?: number },
  ) => Promise<void>;
  // live_avatar audio method (only available when model is live_avatar and no stream is provided)
  playAudio?: (audio: Blob | File | ArrayBuffer) => Promise<void>;
};

export const createRealTimeClient = (opts: RealTimeClientOptions) => {
  const { baseUrl, apiKey, integration } = opts;

  const connect = async (
    stream: MediaStream | null,
    options: RealTimeClientConnectOptions,
  ): Promise<RealTimeClient> => {
    const eventEmitter = mitt<Events>();

    const parsedOptions = realTimeClientConnectOptionsSchema.safeParse(options);
    if (!parsedOptions.success) {
      throw parsedOptions.error;
    }

    const sessionId = uuidv4();
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

    // For live_avatar: prepare avatar image base64 before connection
    let avatarImageBase64: string | undefined;
    if (isAvatarLive && avatar?.avatarImage) {
      let imageBlob: Blob;
      if (typeof avatar.avatarImage === "string") {
        // Fetch image from URL
        const response = await fetch(avatar.avatarImage);
        imageBlob = await response.blob();
      } else {
        imageBlob = avatar.avatarImage;
      }
      avatarImageBase64 = await blobToBase64(imageBlob);
    }

    // For live_avatar: prepare initial prompt to send before WebRTC handshake
    const initialPrompt =
      isAvatarLive && options.initialState?.prompt
        ? { text: options.initialState.prompt.text, enhance: options.initialState.prompt.enhance }
        : undefined;

    const url = `${baseUrl}${options.model.urlPath}`;
    const webrtcManager = new WebRTCManager({
      webrtcUrl: `${url}?api_key=${apiKey}&model=${options.model.name}`,
      apiKey,
      sessionId,
      fps: options.model.fps,
      initialState,
      integration,
      onRemoteStream,
      onConnectionStateChange: (state: "connected" | "connecting" | "disconnected") => {
        eventEmitter.emit("connectionChange", state);
      },
      onError: (error) => {
        console.error("WebRTC error:", error);
        eventEmitter.emit("error", createWebrtcError(error));
      },
      customizeOffer: options.customizeOffer as ((offer: RTCSessionDescriptionInit) => Promise<void>) | undefined,
      vp8MinBitrate: 300,
      vp8StartBitrate: 600,
      isAvatarLive,
      avatarImageBase64,
      initialPrompt,
    });

    // Wire up queue status events (called before connect so we don't miss early messages)
    const wsEmitter = webrtcManager.getWebsocketMessageEmitter();
    wsEmitter.on("status", (msg) => {
      eventEmitter.emit("status", msg.status);
      options.onStatus?.(msg.status);
    });
    wsEmitter.on("queuePosition", (msg) => {
      const data = { position: msg.position, queueSize: msg.queue_size };
      eventEmitter.emit("queuePosition", data);
      options.onQueuePosition?.(data);
    });

    await webrtcManager.connect(inputStream);

    const methods = realtimeMethods(webrtcManager);

    // For non-live_avatar models: send initial prompt after connection is established
    if (!isAvatarLive && options.initialState?.prompt) {
      const { text, enhance } = options.initialState.prompt;
      methods.setPrompt(text, { enhance });
    }

    const client: RealTimeClient = {
      setPrompt: methods.setPrompt,
      isConnected: () => webrtcManager.isConnected(),
      getConnectionState: () => webrtcManager.getConnectionState(),
      disconnect: () => {
        webrtcManager.cleanup();
        audioStreamManager?.cleanup();
      },
      on: eventEmitter.on,
      off: eventEmitter.off,
      sessionId,
      setImage: async (
        image: Blob | File | string | null,
        options?: { prompt?: string; enhance?: boolean; timeout?: number },
      ) => {
        if (image === null) {
          return webrtcManager.setImage(null, options);
        }

        let imageBase64: string;
        if (typeof image === "string") {
          let url: URL | null = null;
          try {
            url = new URL(image);
          } catch {
            // Not a valid URL, treat as raw base64
          }

          if (url?.protocol === "data:") {
            imageBase64 = image.split(",")[1];
          } else if (url?.protocol === "http:" || url?.protocol === "https:") {
            const response = await fetch(image);
            const imageBlob = await response.blob();
            imageBase64 = await blobToBase64(imageBlob);
          } else {
            imageBase64 = image;
          }
        } else {
          imageBase64 = await blobToBase64(image);
        }
        return webrtcManager.setImage(imageBase64, options);
      },
    };

    // Add live_avatar specific audio method (only when using internal AudioStreamManager)
    if (isAvatarLive && audioStreamManager) {
      const manager = audioStreamManager; // Capture for closures
      client.playAudio = (audio: Blob | File | ArrayBuffer) => manager.playAudio(audio);
    }

    return client;
  };

  return {
    connect,
  };
};
