import { z } from "zod";
import { type CustomModelDefinition, type ModelDefinition, modelDefinitionSchema } from "../shared/model";
import { modelStateSchema } from "../shared/types";
import { classifyWebrtcError, type DecartSDKError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import { createEventBuffer } from "./event-buffer";
import { realtimeMethods, type SetInput } from "./methods";
import type { DiagnosticEvent } from "./observability/diagnostics";
import { RealtimeObservability } from "./observability/realtime-observability";
import type { WebRTCStats } from "./observability/webrtc-stats";
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
  logger: Logger;
  telemetryEnabled: boolean;
};

const realTimeClientInitialStateSchema = modelStateSchema;
type OnRemoteStreamFn = (stream: MediaStream) => void;
export type RealTimeClientInitialState = z.infer<typeof realTimeClientInitialStateSchema>;

// ugly workaround to add an optional function to the schema
// https://github.com/colinhacks/zod/issues/4143#issuecomment-2845134912
const createAsyncFunctionSchema = <T extends z.core.$ZodFunction>(schema: T) =>
  z.custom<Parameters<T["implementAsync"]>[0]>((fn) => schema.implementAsync(fn as Parameters<T["implementAsync"]>[0]));

const realTimeClientConnectOptionsSchema = z.object({
  model: modelDefinitionSchema,
  onRemoteStream: z.custom<OnRemoteStreamFn>((val) => typeof val === "function", {
    message: "onRemoteStream must be a function",
  }),
  initialState: realTimeClientInitialStateSchema.optional(),
  customizeOffer: createAsyncFunctionSchema(z.function()).optional(),
});
export type RealTimeClientConnectOptions = Omit<z.infer<typeof realTimeClientConnectOptionsSchema>, "model"> & {
  model: ModelDefinition | CustomModelDefinition;
};

export type Events = {
  connectionChange: ConnectionState;
  error: DecartSDKError;
  generationTick: { seconds: number };
  diagnostic: DiagnosticEvent;
  stats: WebRTCStats;
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
};

export const createRealTimeClient = (opts: RealTimeClientOptions) => {
  const { baseUrl, apiKey, integration, logger } = opts;

  const connect = async (
    stream: MediaStream | null,
    options: RealTimeClientConnectOptions,
  ): Promise<RealTimeClient> => {
    const parsedOptions = realTimeClientConnectOptionsSchema.safeParse(options);
    if (!parsedOptions.success) {
      throw parsedOptions.error;
    }

    const { onRemoteStream, initialState } = parsedOptions.data;

    const inputStream: MediaStream = stream ?? new MediaStream();

    let webrtcManager: WebRTCManager | undefined;
    const { emitter: eventEmitter, emitOrBuffer, flush, stop } = createEventBuffer<Events>();

    const observability = new RealtimeObservability({
      telemetryEnabled: opts.telemetryEnabled,
      apiKey,
      model: options.model.name,
      integration,
      logger,
      onDiagnostic: (event) => emitOrBuffer("diagnostic", event),
      onStats: (stats) => emitOrBuffer("stats", stats),
    });

    try {
      // Prepare initial image base64 before connection
      const initialImage = initialState?.image ? await imageToBase64(initialState.image) : undefined;

      // Prepare initial prompt to send via WebSocket before WebRTC handshake
      const initialPrompt = initialState?.prompt
        ? {
            text: initialState.prompt.text,
            enhance: initialState.prompt.enhance,
          }
        : undefined;

      const url = `${baseUrl}${options.model.urlPath}`;

      webrtcManager = new WebRTCManager({
        webrtcUrl: `${url}?api_key=${encodeURIComponent(apiKey)}&model=${encodeURIComponent(options.model.name)}`,
        integration,
        logger,
        observability,
        onRemoteStream,
        onConnectionStateChange: (state) => {
          emitOrBuffer("connectionChange", state);
        },
        onError: (error) => {
          logger.error("WebRTC error", { error: error.message });
          emitOrBuffer("error", classifyWebrtcError(error));
        },
        customizeOffer: options.customizeOffer as ((offer: RTCSessionDescriptionInit) => Promise<void>) | undefined,
        vp8MinBitrate: 300,
        vp8StartBitrate: 600,
        initialImage,
        initialPrompt,
      });

      const manager = webrtcManager;

      let sessionId: string | null = null;
      let subscribeToken: string | null = null;

      const sessionIdListener = (msg: SessionIdMessage) => {
        subscribeToken = encodeSubscribeToken(msg.session_id, msg.server_ip, msg.server_port);
        sessionId = msg.session_id;
        observability.sessionStarted(msg.session_id);
      };
      manager.getWebsocketMessageEmitter().on("sessionId", sessionIdListener);

      const tickListener = (msg: GenerationTickMessage) => {
        emitOrBuffer("generationTick", { seconds: msg.seconds });
      };
      manager.getWebsocketMessageEmitter().on("generationTick", tickListener);

      await manager.connect(inputStream);

      const methods = realtimeMethods(manager, imageToBase64);

      const client: RealTimeClient = {
        set: methods.set,
        setPrompt: methods.setPrompt,
        isConnected: () => manager.isConnected(),
        getConnectionState: () => manager.getConnectionState(),
        disconnect: () => {
          observability.stop();
          stop();
          manager.cleanup();
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

      flush();
      return client;
    } catch (error) {
      observability.stop();
      webrtcManager?.cleanup();
      throw error;
    }
  };

  const subscribe = async (options: SubscribeOptions): Promise<RealTimeSubscribeClient> => {
    const { sid, ip, port } = decodeSubscribeToken(options.token);
    const subscribeUrl = `${baseUrl}/subscribe/${encodeURIComponent(sid)}?IP=${encodeURIComponent(ip)}&port=${encodeURIComponent(port)}&api_key=${encodeURIComponent(apiKey)}`;

    const { emitter: eventEmitter, emitOrBuffer, flush, stop } = createEventBuffer<SubscribeEvents>();

    let webrtcManager: WebRTCManager | undefined;
    const observability = new RealtimeObservability({
      telemetryEnabled: opts.telemetryEnabled,
      apiKey,
      integration,
      logger,
      onDiagnostic: (event) => emitOrBuffer("diagnostic", event as SubscribeEvents["diagnostic"]),
    });
    observability.sessionStarted(sid);

    try {
      webrtcManager = new WebRTCManager({
        webrtcUrl: subscribeUrl,
        integration,
        logger,
        observability,
        onRemoteStream: options.onRemoteStream,
        onConnectionStateChange: (state) => {
          emitOrBuffer("connectionChange", state);
        },
        onError: (error) => {
          logger.error("WebRTC subscribe error", { error: error.message });
          emitOrBuffer("error", classifyWebrtcError(error));
        },
      });

      const manager = webrtcManager;
      await manager.connect(null);

      const client: RealTimeSubscribeClient = {
        isConnected: () => manager.isConnected(),
        getConnectionState: () => manager.getConnectionState(),
        disconnect: () => {
          observability.stop();
          stop();
          manager.cleanup();
        },
        on: eventEmitter.on,
        off: eventEmitter.off,
      };

      flush();
      return client;
    } catch (error) {
      observability.stop();
      webrtcManager?.cleanup();
      throw error;
    }
  };

  return {
    connect,
    subscribe,
  };
};
