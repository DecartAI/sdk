import { z } from "zod";
import { type CustomModelDefinition, type ModelDefinition, modelDefinitionSchema } from "../shared/model";
import { modelStateSchema } from "../shared/types";
import { classifyWebrtcError, type DecartSDKError } from "../utils/errors";
import type { Logger } from "../utils/logger";
import { AudioStreamManager } from "./audio-stream-manager";
import type { CompositeLatencyEstimate } from "./composite-latency";
import type { DiagnosticEmitter, DiagnosticEvent } from "./diagnostics";
import { createEventBuffer } from "./event-buffer";
import { IVSManager } from "./ivs-manager";
import { IVSStatsCollector } from "./ivs-stats-collector";
import { LatencyDiagnostics } from "./latency-diagnostics";
import { realtimeMethods, type SetInput } from "./methods";
import type { PixelLatencyMeasurement } from "./pixel-latency";
import {
  decodeSubscribeToken,
  encodeSubscribeToken,
  type RealTimeSubscribeClient,
  type SubscribeEvents,
  type SubscribeOptions,
} from "./subscribe-client";
import { type ITelemetryReporter, NullTelemetryReporter, TelemetryReporter } from "./telemetry-reporter";
import type { RealtimeTransportManager } from "./transport-manager";
import type { ConnectionState, GenerationTickMessage, SessionIdMessage } from "./types";
import { WebRTCManager } from "./webrtc-manager";
import { type WebRTCStats, WebRTCStatsCollector } from "./webrtc-stats";

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
  transport: z.enum(["webrtc", "ivs"]).optional().default("webrtc"),
  latencyTracking: z
    .object({
      composite: z.boolean().optional(),
      pixelMarker: z.boolean().optional(),
      videoElement: z.custom<HTMLVideoElement>().optional(),
    })
    .optional(),
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
  compositeLatency: CompositeLatencyEstimate;
  pixelLatency: PixelLatencyMeasurement;
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

    const transport = parsedOptions.data.transport;
    let transportManager: RealtimeTransportManager | undefined;
    let telemetryReporter: ITelemetryReporter = new NullTelemetryReporter();
    let handleConnectionStateChange: ((state: ConnectionState) => void) | null = null;

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

      const sharedCallbacks = {
        integration,
        logger,
        onDiagnostic: ((name: DiagnosticEvent["name"], data: DiagnosticEvent["data"]) => {
          emitOrBuffer("diagnostic", { name, data } as Events["diagnostic"]);
          addTelemetryDiagnostic(name, data);
        }) as DiagnosticEmitter,
        onRemoteStream,
        onConnectionStateChange: (state: ConnectionState) => {
          emitOrBuffer("connectionChange", state);
          handleConnectionStateChange?.(state);
        },
        onError: (error: Error) => {
          logger.error(`${transport} error`, { error: error.message });
          emitOrBuffer("error", classifyWebrtcError(error));
        },
        modelName: options.model.name,
        initialImage,
        initialPrompt,
      };

      if (transport === "ivs") {
        const ivsUrlPath = options.model.urlPath.replace(/\/?$/, "-ivs");
        transportManager = new IVSManager({
          ivsUrl: `${baseUrl}${ivsUrlPath}?api_key=${encodeURIComponent(apiKey)}&model=${encodeURIComponent(options.model.name)}`,
          ...sharedCallbacks,
        });
      } else {
        transportManager = new WebRTCManager({
          webrtcUrl: `${url}?api_key=${encodeURIComponent(apiKey)}&model=${encodeURIComponent(options.model.name)}`,
          ...sharedCallbacks,
          customizeOffer: options.customizeOffer as ((offer: RTCSessionDescriptionInit) => Promise<void>) | undefined,
          vp8MinBitrate: 300,
          vp8StartBitrate: 600,
        });
      }

      const manager = transportManager;

      let sessionId: string | null = null;
      let subscribeToken: string | null = null;
      const pendingTelemetryDiagnostics: Array<{
        name: DiagnosticEvent["name"];
        data: DiagnosticEvent["data"];
        timestamp: number;
      }> = [];
      let telemetryReporterReady = false;

      const addTelemetryDiagnostic = (
        name: DiagnosticEvent["name"],
        data: DiagnosticEvent["data"],
        timestamp: number = Date.now(),
      ): void => {
        if (!opts.telemetryEnabled) {
          return;
        }

        if (!telemetryReporterReady) {
          pendingTelemetryDiagnostics.push({ name, data, timestamp });
          return;
        }

        telemetryReporter.addDiagnostic({ name, data, timestamp });
      };

      const sessionIdListener = (msg: SessionIdMessage) => {
        subscribeToken = encodeSubscribeToken(msg.session_id, msg.server_ip, msg.server_port, transport);
        sessionId = msg.session_id;

        // Start telemetry reporter now that we have a session ID
        if (opts.telemetryEnabled) {
          if (telemetryReporterReady) {
            telemetryReporter.stop();
          }

          const reporter = new TelemetryReporter({
            apiKey,
            sessionId: msg.session_id,
            model: options.model.name,
            integration,
            transport,
            logger,
          });
          reporter.start();
          telemetryReporter = reporter;
          telemetryReporterReady = true;

          for (const diagnostic of pendingTelemetryDiagnostics) {
            telemetryReporter.addDiagnostic(diagnostic);
          }
          pendingTelemetryDiagnostics.length = 0;
        }
      };
      manager.getWebsocketMessageEmitter().on("sessionId", sessionIdListener);

      const tickListener = (msg: GenerationTickMessage) => {
        emitOrBuffer("generationTick", { seconds: msg.seconds });
      };
      manager.getWebsocketMessageEmitter().on("generationTick", tickListener);

      // Latency diagnostics (composite + pixel marker) — create before connect
      // so the stamper can wrap inputStream before it's published.
      let latencyStartTimer: ReturnType<typeof setTimeout> | undefined;
      let latencyDiag: LatencyDiagnostics | null = null;
      if (parsedOptions.data.latencyTracking) {
        latencyDiag = new LatencyDiagnostics({
          ...parsedOptions.data.latencyTracking,
          sendMessage: (msg) => manager.sendMessage(msg),
          onCompositeLatency: (est) => emitOrBuffer("compositeLatency", est),
          onPixelLatency: (m) => emitOrBuffer("pixelLatency", m),
        });

        // Wrap camera stream with canvas stamper for E2E pixel latency
        if (parsedOptions.data.latencyTracking.pixelMarker && inputStream) {
          inputStream = await latencyDiag.createStamper(inputStream);
        }
      }

      await manager.connect(inputStream);

      const methods = realtimeMethods(manager, imageToBase64);

      // Video stall detection state (Twilio pattern: fps < 0.5 = stalled)
      const STALL_FPS_THRESHOLD = 0.5;
      let videoStalled = false;
      let stallStartMs = 0;

      const handleStats = (stats: WebRTCStats): void => {
        emitOrBuffer("stats", stats);
        telemetryReporter.addStats(stats);

        // Stall detection: check if video fps dropped below threshold
        const fps = stats.video?.framesPerSecond ?? 0;
        if (!videoStalled && stats.video && fps < STALL_FPS_THRESHOLD) {
          videoStalled = true;
          stallStartMs = Date.now();
          emitOrBuffer("diagnostic", { name: "videoStall", data: { stalled: true, durationMs: 0 } });
          addTelemetryDiagnostic("videoStall", { stalled: true, durationMs: 0 }, stallStartMs);
        } else if (videoStalled && fps >= STALL_FPS_THRESHOLD) {
          const durationMs = Date.now() - stallStartMs;
          videoStalled = false;
          emitOrBuffer("diagnostic", { name: "videoStall", data: { stalled: false, durationMs } });
          addTelemetryDiagnostic("videoStall", { stalled: false, durationMs });
        }
      };

      let statsCollector: WebRTCStatsCollector | IVSStatsCollector | null = null;
      let statsCollectorPeerConnection: RTCPeerConnection | null = null;

      if (transport === "webrtc" && manager instanceof WebRTCManager) {
        const webrtcManager = manager;

        const startStatsCollection = (): (() => void) => {
          statsCollector?.stop();
          videoStalled = false;
          stallStartMs = 0;
          const collector = new WebRTCStatsCollector();
          statsCollector = collector;
          const pc = webrtcManager.getPeerConnection();
          statsCollectorPeerConnection = pc;
          if (pc) {
            collector.start(pc, handleStats);
          }
          return () => {
            collector.stop();
            statsCollector = null;
            statsCollectorPeerConnection = null;
          };
        };

        handleConnectionStateChange = (state) => {
          if (!opts.telemetryEnabled) {
            return;
          }

          if (state !== "connected" && state !== "generating") {
            return;
          }

          const peerConnection = webrtcManager.getPeerConnection();
          if (!peerConnection || peerConnection === statsCollectorPeerConnection) {
            return;
          }

          startStatsCollection();
        };

        // Auto-start stats when telemetry is enabled
        if (opts.telemetryEnabled) {
          startStatsCollection();
        }
      } else if (transport === "ivs" && manager instanceof IVSManager) {
        const ivsManager = manager;

        const startIVSStatsCollection = (): void => {
          statsCollector?.stop();
          videoStalled = false;
          stallStartMs = 0;
          const collector = new IVSStatsCollector();
          statsCollector = collector;
          collector.start(ivsManager, handleStats);
        };

        handleConnectionStateChange = (state) => {
          if (!opts.telemetryEnabled) {
            return;
          }

          if (state !== "connected" && state !== "generating") {
            return;
          }

          // Only start once — IVS doesn't have PC reconnection like WebRTC
          if (!statsCollector?.isRunning()) {
            startIVSStatsCollection();
          }
        };

        // Auto-start stats when telemetry is enabled
        if (opts.telemetryEnabled) {
          startIVSStatsCollection();
        }
      }

      // Wire latency diagnostics events and start delayed
      if (latencyDiag) {
        manager.getWebsocketMessageEmitter().on("latencyReport", (msg) => latencyDiag!.onServerReport(msg));
        eventEmitter.on("stats", (stats) => latencyDiag!.onStats(stats));
        latencyStartTimer = setTimeout(() => latencyDiag?.start(), 1000);
      }

      const client: RealTimeClient = {
        set: methods.set,
        setPrompt: methods.setPrompt,
        isConnected: () => manager.isConnected(),
        getConnectionState: () => manager.getConnectionState(),
        disconnect: () => {
          clearTimeout(latencyStartTimer);
          latencyDiag?.stop();
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
      };

      // Add live_avatar specific audio method (only when using internal AudioStreamManager)
      if (isAvatarLive && audioStreamManager) {
        const manager = audioStreamManager; // Capture for closures
        client.playAudio = (audio: Blob | File | ArrayBuffer) => manager.playAudio(audio);
      }

      flush();
      return client;
    } catch (error) {
      telemetryReporter.stop();
      transportManager?.cleanup();
      audioStreamManager?.cleanup();
      throw error;
    }
  };

  const subscribeWebRTC = async (
    options: SubscribeOptions,
    sid: string,
    ip: string,
    port: number,
  ): Promise<RealTimeSubscribeClient> => {
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

  const subscribeIVS = async (options: SubscribeOptions, sid: string): Promise<RealTimeSubscribeClient> => {
    const { getIVSBroadcastClient } = await import("./ivs-connection");
    const ivs = await getIVSBroadcastClient();

    const { emitter: eventEmitter, emitOrBuffer, flush, stop } = createEventBuffer<SubscribeEvents>();

    // Fetch viewer token from bouncer (convert wss:// → https:// for HTTP call)
    const httpBaseUrl = baseUrl.replace(/^wss:\/\//, "https://").replace(/^ws:\/\//, "http://");
    const resp = await fetch(`${httpBaseUrl}/v1/subscribe-ivs/${encodeURIComponent(sid)}`, {
      headers: { "x-api-key": apiKey },
    });
    if (!resp.ok) {
      throw new Error(`Failed to get IVS viewer token: ${resp.status}`);
    }
    const { subscribe_token, server_publish_participant_id } = (await resp.json()) as {
      subscribe_token: string;
      server_publish_participant_id: string;
    };

    let connected = false;
    let connectionState: ConnectionState = "connecting";
    emitOrBuffer("connectionChange", connectionState);

    // Create subscribe-only IVS stage — filter to server's output stream only
    const subscribeStrategy = {
      stageStreamsToPublish: () => [] as never[],
      shouldPublishParticipant: () => false,
      shouldSubscribeToParticipant: (participant: { id: string }) => {
        if (server_publish_participant_id && participant.id !== server_publish_participant_id) {
          return ivs.SubscribeType.NONE;
        }
        return ivs.SubscribeType.AUDIO_VIDEO;
      },
    };

    const stage = new ivs.Stage(subscribe_token, subscribeStrategy);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("IVS viewer subscribe timeout")), 30_000);

      stage.on(ivs.StageEvents.STAGE_PARTICIPANT_STREAMS_ADDED, (...args: unknown[]) => {
        const participant = args[0] as { isLocal: boolean };
        const streams = args[1] as { mediaStreamTrack: MediaStreamTrack }[];
        if (participant.isLocal) return;

        clearTimeout(timer);
        const remoteStream = new MediaStream();
        for (const s of streams) {
          remoteStream.addTrack(s.mediaStreamTrack);
        }
        options.onRemoteStream(remoteStream);
        connected = true;
        connectionState = "connected";
        emitOrBuffer("connectionChange", connectionState);
        resolve();
      });

      stage.on(ivs.StageEvents.STAGE_CONNECTION_STATE_CHANGED, (...args: unknown[]) => {
        const state = args[0] as string;
        if (state === ivs.ConnectionState.DISCONNECTED.toString()) {
          clearTimeout(timer);
          connected = false;
          connectionState = "disconnected";
          emitOrBuffer("connectionChange", connectionState);
        }
      });

      stage.join().catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    const client: RealTimeSubscribeClient = {
      isConnected: () => connected,
      getConnectionState: () => connectionState,
      disconnect: () => {
        stop();
        stage.leave();
        connected = false;
        connectionState = "disconnected";
      },
      on: eventEmitter.on,
      off: eventEmitter.off,
    };

    flush();
    return client;
  };

  const subscribe = async (options: SubscribeOptions): Promise<RealTimeSubscribeClient> => {
    const { sid, ip, port, transport } = decodeSubscribeToken(options.token);

    if (transport === "ivs") {
      return subscribeIVS(options, sid);
    }
    return subscribeWebRTC(options, sid, ip, port);
  };

  return {
    connect,
    subscribe,
  };
};
