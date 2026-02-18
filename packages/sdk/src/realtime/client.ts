import { z } from "zod";
import { modelDefinitionSchema, type RealTimeModels } from "../shared/model";
import { modelStateSchema } from "../shared/types";
import { classifyWebrtcError, type DecartSDKError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import { AudioStreamManager } from "./audio-stream-manager";
import type { DiagnosticEvent } from "./diagnostics";
import { createEventBuffer } from "./event-buffer";
import { realtimeMethods, type SetInput } from "./methods";
import {
  decodeSubscribeToken,
  encodeSubscribeToken,
  type RealTimeSubscribeClient,
  type SubscribeEvents,
  type SubscribeOptions,
} from "./subscribe-client";
import { type ITelemetryReporter, NullTelemetryReporter, TelemetryReporter } from "./telemetry-reporter";
import type { ConnectionState, GenerationTickMessage, SessionIdMessage } from "./types";
import { WebRTCManager } from "./webrtc-manager";
import { type StatsOptions, type WebRTCStats, WebRTCStatsCollector } from "./webrtc-stats";

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
export type RealTimeClientConnectOptions = z.infer<typeof realTimeClientConnectOptionsSchema>;

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
  playAudio?: (audio: Blob | File | ArrayBuffer) => Promise<void>;
  /** Start collecting WebRTC stats. Stats are emitted via the 'stats' event. Returns a stop function. */
  startStats: (options?: StatsOptions) => () => void;
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

    const isAvatarLive = options.model.name === "live_avatar";

    const { onRemoteStream, initialState } = parsedOptions.data;

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

      const { emitter: eventEmitter, emitOrBuffer, flush, stop } = createEventBuffer<Events>();

      webrtcManager = new WebRTCManager({
        webrtcUrl: `${url}?api_key=${encodeURIComponent(apiKey)}&model=${encodeURIComponent(options.model.name)}`,
        integration,
        logger,
        onDiagnostic: (name, data) => {
          emitOrBuffer("diagnostic", { name, data } as Events["diagnostic"]);
          telemetryReporter.addDiagnostic({ name, data, timestamp: Date.now() });
        },
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
        modelName: options.model.name as RealTimeModels,
        initialImage,
        initialPrompt,
      });

      const manager = webrtcManager;

      let sessionId: string | null = null;
      let subscribeToken: string | null = null;
      let telemetryReporter: ITelemetryReporter = new NullTelemetryReporter();

      const sessionIdListener = (msg: SessionIdMessage) => {
        subscribeToken = encodeSubscribeToken(msg.session_id, msg.server_ip, msg.server_port);
        sessionId = msg.session_id;

        // Start telemetry reporter now that we have a session ID
        if (opts.telemetryEnabled) {
          const reporter = new TelemetryReporter({
            apiKey,
            sessionId: msg.session_id,
            integration,
            logger,
          });
          reporter.start();
          telemetryReporter = reporter;
        }
      };
      manager.getWebsocketMessageEmitter().on("sessionId", sessionIdListener);

      const tickListener = (msg: GenerationTickMessage) => {
        emitOrBuffer("generationTick", { seconds: msg.seconds });
      };
      manager.getWebsocketMessageEmitter().on("generationTick", tickListener);

      await manager.connect(inputStream);

      const methods = realtimeMethods(manager, imageToBase64);

      let statsCollector: WebRTCStatsCollector | null = null;

      // Video stall detection state (Twilio pattern: fps < 0.5 = stalled)
      const STALL_FPS_THRESHOLD = 0.5;
      let videoStalled = false;
      let stallStartMs = 0;

      const startStatsCollection = (statsOptions?: StatsOptions): (() => void) => {
        statsCollector?.stop();
        videoStalled = false;
        stallStartMs = 0;
        statsCollector = new WebRTCStatsCollector(statsOptions);
        const pc = manager.getPeerConnection();
        if (pc) {
          statsCollector.start(pc, (stats) => {
            emitOrBuffer("stats", stats);
            telemetryReporter.addStats(stats);

            // Stall detection: check if video fps dropped below threshold
            const fps = stats.video?.framesPerSecond ?? 0;
            if (!videoStalled && stats.video && fps < STALL_FPS_THRESHOLD) {
              videoStalled = true;
              stallStartMs = Date.now();
              emitOrBuffer("diagnostic", { name: "videoStall", data: { stalled: true, durationMs: 0 } });
              telemetryReporter.addDiagnostic({
                name: "videoStall",
                data: { stalled: true, durationMs: 0 },
                timestamp: stallStartMs,
              });
            } else if (videoStalled && fps >= STALL_FPS_THRESHOLD) {
              const durationMs = Date.now() - stallStartMs;
              videoStalled = false;
              emitOrBuffer("diagnostic", { name: "videoStall", data: { stalled: false, durationMs } });
              telemetryReporter.addDiagnostic({
                name: "videoStall",
                data: { stalled: false, durationMs },
                timestamp: Date.now(),
              });
            }
          });
        }
        return () => {
          statsCollector?.stop();
          statsCollector = null;
        };
      };

      // Auto-start stats when telemetry is enabled
      if (opts.telemetryEnabled) {
        startStatsCollection();
      }

      const client: RealTimeClient = {
        set: methods.set,
        setPrompt: methods.setPrompt,
        isConnected: () => manager.isConnected(),
        getConnectionState: () => manager.getConnectionState(),
        disconnect: () => {
          statsCollector?.stop();
          telemetryReporter.stop();
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
        startStats: startStatsCollection,
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
        logger,
        onDiagnostic: (name, data) => {
          emitOrBuffer("diagnostic", { name, data } as SubscribeEvents["diagnostic"]);
        },
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
