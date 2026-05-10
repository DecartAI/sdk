import { z } from "zod";
import { type CustomModelDefinition, type ModelDefinition, modelDefinitionSchema } from "../shared/model";
import { modelStateSchema } from "../shared/types";
import { classifyWebrtcError, type DecartSDKError } from "../utils/errors";
import { createConsoleLogger, type Logger } from "../utils/logger";
import { imageToBase64 } from "../utils/media";
import { createEventBuffer } from "./event-buffer";
import { LiveKitManager } from "./livekit-manager";
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
import type {
  ConnectionChangeDetails,
  ConnectionState,
  GenerationEndedMessage,
  GenerationTickMessage,
  LiveKitRoomInfoMessage,
  QueuePosition,
  SessionIdMessage,
} from "./types";

export type RealTimeClientOptions = {
  baseUrl: string;
  apiKey: string;
  integration?: string;
  logger: Logger;
  telemetryEnabled: boolean;
};

const realTimeClientInitialStateSchema = modelStateSchema;
type OnRemoteStreamFn = (stream: MediaStream) => void;
type OnConnectionChangeFn = (state: ConnectionState, details?: ConnectionChangeDetails) => void;
type OnQueuePositionFn = (queuePosition: QueuePosition) => void;
export type RealTimeClientInitialState = z.infer<typeof realTimeClientInitialStateSchema>;

const realTimeClientConnectOptionsSchema = z.object({
  model: modelDefinitionSchema,
  onRemoteStream: z.custom<OnRemoteStreamFn>((val) => typeof val === "function", {
    message: "onRemoteStream must be a function",
  }),
  onConnectionChange: z
    .custom<OnConnectionChangeFn>((val) => typeof val === "function", {
      message: "onConnectionChange must be a function",
    })
    .optional(),
  onQueuePosition: z
    .custom<OnQueuePositionFn>((val) => typeof val === "function", {
      message: "onQueuePosition must be a function",
    })
    .optional(),
  initialState: realTimeClientInitialStateSchema.optional(),
  queryParams: z.record(z.string(), z.string()).optional(),
});
export type RealTimeClientConnectOptions = Omit<z.infer<typeof realTimeClientConnectOptionsSchema>, "model"> & {
  model: ModelDefinition | CustomModelDefinition;
};

export type Events = {
  connectionChange: ConnectionState;
  pending: QueuePosition;
  queuePosition: QueuePosition;
  error: DecartSDKError;
  generationTick: { seconds: number };
  generationEnded: { seconds: number; reason: string };
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
  getSubscribeToken: () => string | null;
  setImage: (
    image: Blob | File | string | null,
    options?: { prompt?: string; enhance?: boolean; timeout?: number },
  ) => Promise<void>;
};

export const createRealTimeClient = (opts: RealTimeClientOptions) => {
  const { baseUrl, apiKey, integration } = opts;
  const logger = opts.logger ?? createConsoleLogger("info");

  const connect = async (
    stream: MediaStream | null,
    options: RealTimeClientConnectOptions,
  ): Promise<RealTimeClient> => {
    const parsedOptions = realTimeClientConnectOptionsSchema.safeParse(options);
    if (!parsedOptions.success) {
      throw parsedOptions.error;
    }

    const { onRemoteStream, onConnectionChange, onQueuePosition, initialState } = parsedOptions.data;

    const inputStream = stream ?? new MediaStream();

    let livekitManager: LiveKitManager | undefined;
    let observability: RealtimeObservability | undefined;

    try {
      // Prepare initial image base64 before connection
      const initialImage = initialState?.image ? await imageToBase64(initialState.image) : undefined;

      // Prepare initial prompt to send over the control WebSocket before joining LiveKit.
      const initialPrompt = initialState?.prompt
        ? {
            text: initialState.prompt.text,
            enhance: initialState.prompt.enhance,
          }
        : undefined;

      const url = `${baseUrl}${options.model.urlPath}`;

      const { emitter: eventEmitter, emitOrBuffer, flush, stop } = createEventBuffer<Events>();
      observability = new RealtimeObservability({
        telemetryEnabled: opts.telemetryEnabled,
        apiKey,
        model: options.model.name,
        integration,
        logger,
        onDiagnostic: (event) => emitOrBuffer("diagnostic", event),
        onStats: (stats) => emitOrBuffer("stats", stats),
      });
      const queryParams = new URLSearchParams({
        ...(options.queryParams ?? {}),
        api_key: apiKey,
        model: options.model.name,
      });

      livekitManager = new LiveKitManager({
        url: `${url}?${queryParams.toString()}`,
        integration,
        logger,
        observability,
        onRemoteStream,
        onConnectionStateChange: (state, details) => {
          emitOrBuffer("connectionChange", state);
          if (state === "pending" && details?.queuePosition) {
            emitOrBuffer("pending", details.queuePosition);
          }
          onConnectionChange?.(state, details);
        },
        onQueuePosition: (queuePosition) => {
          emitOrBuffer("queuePosition", queuePosition);
          onQueuePosition?.(queuePosition);
        },
        onError: (error) => {
          logger.error("Realtime error", { error: error.message });
          emitOrBuffer("error", classifyWebrtcError(error));
        },
        initialImage,
        initialPrompt,
      });

      const manager = livekitManager;

      let sessionId: string | null = null;
      let subscribeToken: string | null = null;

      const sessionIdListener = (msg: SessionIdMessage) => {
        sessionId = msg.session_id;
        observability?.sessionStarted(msg.session_id);
      };
      manager.getWebsocketMessageEmitter().on("sessionId", sessionIdListener);

      const roomInfoListener = (msg: LiveKitRoomInfoMessage) => {
        subscribeToken = encodeSubscribeToken(msg.room_name);
      };
      manager.getWebsocketMessageEmitter().on("roomInfo", roomInfoListener);

      const tickListener = (msg: GenerationTickMessage) => {
        emitOrBuffer("generationTick", { seconds: msg.seconds });
      };
      manager.getWebsocketMessageEmitter().on("generationTick", tickListener);

      const generationEndedListener = (msg: GenerationEndedMessage) => {
        emitOrBuffer("generationEnded", { seconds: msg.seconds, reason: msg.reason });
      };
      manager.getWebsocketMessageEmitter().on("generationEnded", generationEndedListener);

      await manager.connect(inputStream);

      const methods = realtimeMethods(manager, imageToBase64);

      const client: RealTimeClient = {
        set: methods.set,
        setPrompt: methods.setPrompt,
        isConnected: () => manager.isConnected(),
        getConnectionState: () => manager.getConnectionState(),
        disconnect: () => {
          observability?.stop();
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
        getSubscribeToken: () => subscribeToken,
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
      observability?.stop();
      livekitManager?.cleanup();
      throw error;
    }
  };

  const subscribe = async (options: SubscribeOptions): Promise<RealTimeSubscribeClient> => {
    const { room_name: roomName } = decodeSubscribeToken(options.token);
    const subscribeUrl = `${baseUrl}/watch-stream/${encodeURIComponent(roomName)}?api_key=${encodeURIComponent(apiKey)}`;

    const { emitter: eventEmitter, emitOrBuffer, flush, stop } = createEventBuffer<SubscribeEvents>();

    let livekitManager: LiveKitManager | undefined;
    let observability: RealtimeObservability | undefined;

    try {
      observability = new RealtimeObservability({
        telemetryEnabled: false,
        apiKey,
        integration,
        logger,
        onDiagnostic: (event) => emitOrBuffer("diagnostic", event),
      });

      livekitManager = new LiveKitManager({
        url: subscribeUrl,
        integration,
        logger,
        observability,
        onRemoteStream: options.onRemoteStream,
        onConnectionStateChange: (state, details) => {
          emitOrBuffer("connectionChange", state);
          if (state === "pending" && details?.queuePosition) {
            emitOrBuffer("pending", details.queuePosition);
          }
          options.onConnectionChange?.(state, details);
        },
        onQueuePosition: (queuePosition) => {
          emitOrBuffer("queuePosition", queuePosition);
          options.onQueuePosition?.(queuePosition);
        },
        onError: (error) => {
          logger.error("Realtime subscribe error", { error: error.message });
          emitOrBuffer("error", classifyWebrtcError(error));
        },
      });

      const manager = livekitManager;
      await manager.connect(null);

      const client: RealTimeSubscribeClient = {
        isConnected: () => manager.isConnected(),
        getConnectionState: () => manager.getConnectionState(),
        disconnect: () => {
          observability?.stop();
          stop();
          manager.cleanup();
        },
        on: eventEmitter.on,
        off: eventEmitter.off,
      };

      flush();
      return client;
    } catch (error) {
      observability?.stop();
      livekitManager?.cleanup();
      throw error;
    }
  };

  return {
    connect,
    subscribe,
  };
};
