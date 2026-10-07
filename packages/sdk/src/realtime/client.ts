import { z } from "zod";
import { isFileRefId } from "../files/types";
import {
  type CustomModelDefinition,
  type ModelDefinition,
  modelDefinitionSchema,
  realtimeSpeedSchema,
  resolveFpsNumber,
} from "../shared/model";
import { modelStateSchema } from "../shared/types";
import { classifyWebrtcError, type DecartSDKError, DecartSDKException } from "../utils/errors";
import { createConsoleLogger, type Logger } from "../utils/logger";
import { imageToBase64 } from "../utils/media";
import { type ApiKeyProvider, createCredentialSource } from "./credential";
import { createEventBuffer } from "./event-buffer";
import type { MediaChannelFactory, VideoCodec } from "./media-channel";
import { realtimeMethods, type SetInput } from "./methods";
import type { ConnectionQualityReport } from "./observability/connection-quality";
import type { DiagnosticEvent } from "./observability/diagnostics";
import type { RealtimeObservability, RealtimeObservabilityOptions } from "./observability/realtime-observability";
import type { WebRTCStats } from "./observability/webrtc-stats";
import { StreamSession } from "./stream-session";
import type {
  ConnectionState,
  GenerationEnded,
  GenerationTick,
  ImageSetOptions,
  QueuePosition,
  SessionEnded,
} from "./types";

export type RealTimeClientOptions = {
  baseUrl: string;
  apiKey: string;
  /** Called before every dial (connect, connect retry, reconnect) for a fresh credential; wins over `apiKey`. */
  apiKeyProvider?: ApiKeyProvider;
  integration?: string;
  logger: Logger;
  telemetryEnabled: boolean;
  prepareConnection: PrepareConnection;
};

export type PreparedConnection = {
  stream: MediaStream;
  observability: RealtimeObservability;
  frameTiming?: boolean;
  videoCodec?: VideoCodec;
  queryParams?: Record<string, string>;
  createMediaChannel: MediaChannelFactory;
  dispose(): void;
};

export type PrepareConnection = (options: {
  stream: MediaStream | null;
  mirror: "auto" | boolean;
  preferredVideoCodec?: VideoCodec;
  fps: number;
  logger: Logger;
  observability: RealtimeObservabilityOptions;
}) => PreparedConnection;

const realTimeClientInitialStateSchema = modelStateSchema;
type OnRemoteStreamFn = (stream: MediaStream) => void;
type OnConnectionChangeFn = (state: ConnectionState) => void;
type OnConnectionQualityFn = (report: ConnectionQualityReport) => void;
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
  onConnectionQuality: z
    .custom<OnConnectionQualityFn>((val) => typeof val === "function", {
      message: "onConnectionQuality must be a function",
    })
    .optional(),
  onQueuePosition: z
    .custom<OnQueuePositionFn>((val) => typeof val === "function", {
      message: "onQueuePosition must be a function",
    })
    .optional(),
  initialState: realTimeClientInitialStateSchema.optional(),
  queryParams: z.record(z.string(), z.string()).optional(),
  mirror: z.union([z.literal("auto"), z.boolean()]).optional(),
  resolution: z.enum(["720p", "1080p"]).optional(),
  /**
   * Realtime speed tier. Fast mode (`"fast"`) serves the session from a higher-compute tier for lower
   * latency and higher throughput; output quality is unchanged. It is currently available for `lucy-2.5` /
   * `lucy-latest` and `lucy-vton-3.5` / `lucy-vton-latest`, in the US region only, and is billed at 2x the
   * standard realtime rate for those models. Other models ignore the option (the SDK logs a warning when the
   * model does not list it in `supportedSpeeds`). Omit it (the default) for standard mode.
   */
  speed: realtimeSpeedSchema.optional(),
  /**
   * How many times a failed connect is re-dialled before `connect()` rejects (default 5, exponential
   * backoff from 1 s to 10 s). `0` dials exactly once. Apps that hand out connects from their own session
   * queue should pass `0`: every retry is a fresh dial that competes with the people waiting in line.
   * Refusals the server will not change its mind about (policy close 1008, concurrent-session limit
   * 1013 "Session Limit Reached") are never retried regardless. Does not affect the automatic
   * reconnect after an established session drops.
   */
  retries: z.number().int().min(0).optional(),
  /** Local track publish codec. Desktop Safari is always pinned to vp8 and ignores this value. */
  preferredVideoCodec: z.enum(["h264", "vp8", "vp9"]).optional(),
  /**
   * Subscribe to the server's audio track. Defaults to `true` only when the input
   * stream carries an audio track: the server's audio is a passthrough of the
   * client's, so a video-only session has nothing to hear, and subscribing would
   * start the device's audio engine (on iOS that alone shows the microphone
   * permission prompt). Set `true` to always receive the remote audio track,
   * `false` to never receive it.
   */
  remoteAudio: z.boolean().optional(),
  /**
   * @deprecated Glass-to-glass measurement now runs automatically in browsers
   * when LiveKit frame metadata is available. This legacy flag is accepted for
   * compatibility and no longer gates measurement.
   */
  debugQuality: z.boolean().optional(),
});
export type RealtimeMediaStream = {
  getTracks(): unknown[];
  getAudioTracks(): unknown[];
  getVideoTracks(): unknown[];
};

export type RealTimeClientConnectOptions<TStream extends RealtimeMediaStream = MediaStream> = Omit<
  z.infer<typeof realTimeClientConnectOptionsSchema>,
  "model" | "onRemoteStream"
> & {
  model: ModelDefinition | CustomModelDefinition;
  onRemoteStream: (stream: TStream) => void;
};

export type Events = {
  connectionChange: ConnectionState;
  connectionQuality: ConnectionQualityReport;
  queuePosition: QueuePosition;
  error: DecartSDKError;
  generationTick: GenerationTick;
  generationEnded: GenerationEnded;
  /** Terminal: the server ended the session and no reconnect is coming. */
  sessionEnded: SessionEnded;
  diagnostic: DiagnosticEvent;
  stats: WebRTCStats;
};

export type RealTimeClient = {
  set: (input: SetInput) => Promise<void>;
  setPrompt: (prompt: string, { enhance }?: { enhance?: boolean }) => Promise<void>;
  isConnected: () => boolean;
  getConnectionState: () => ConnectionState;
  /** Latest interpreted connection-quality verdict, or null before any stats arrive. */
  getConnectionQuality: () => ConnectionQualityReport | null;
  disconnect: () => void;
  on: <K extends keyof Events>(event: K, listener: (data: Events[K]) => void) => void;
  off: <K extends keyof Events>(event: K, listener: (data: Events[K]) => void) => void;
  sessionId: string | null;
  subscribeToken: string | null;
  getSubscribeToken: () => string | null;
  /**
   * Set the reference image for the session.
   * - `Blob`/`File`/data URL/http(s) URL/base64 string: bytes traverse the wire as base64.
   * - `"file_..."` id (from `client.files.upload(...).id`): sent as a server-side reference.
   * - `null`: clear the current image.
   */
  setImage: (image: Blob | File | string | null, options?: ImageSetOptions) => Promise<void>;
  replaceVideoTrack: (track: MediaStreamTrack) => Promise<void>;
};

export const createRealTimeClient = (opts: RealTimeClientOptions) => {
  const { baseUrl, integration } = opts;
  const logger = opts.logger ?? createConsoleLogger("info");
  const nextCredential = createCredentialSource({ apiKey: opts.apiKey, apiKeyProvider: opts.apiKeyProvider });

  const connect = async (
    stream: MediaStream | null,
    options: RealTimeClientConnectOptions,
  ): Promise<RealTimeClient> => {
    const parsedOptions = realTimeClientConnectOptionsSchema.safeParse(options);
    if (!parsedOptions.success) throw parsedOptions.error;
    const {
      onRemoteStream,
      onConnectionChange,
      onConnectionQuality,
      onQueuePosition,
      initialState,
      queryParams: extraQueryParams,
      resolution,
      speed,
      retries,
      preferredVideoCodec,
      remoteAudio,
    } = parsedOptions.data;
    const mirror = parsedOptions.data.mirror ?? false;

    let session: StreamSession | undefined;
    let observability: RealtimeObservability | undefined;
    let preparedConnection: PreparedConnection | undefined;

    try {
      const initialImageRef = isFileRefId(initialState?.image) ? initialState.image : undefined;
      // Before any setup: an expired client token is refused here, not by the server after a round
      // trip. The provider round trip and the image encoding do not depend on each other.
      const [credential, initialImage] = await Promise.all([
        nextCredential(),
        initialImageRef === undefined && initialState?.image ? imageToBase64(initialState.image) : undefined,
      ]);
      const initialPrompt = initialState?.prompt
        ? { text: initialState.prompt.text, enhance: initialState.prompt.enhance }
        : undefined;

      const url = `${baseUrl}${options.model.urlPath}`;
      const { emitter: eventEmitter, emitOrBuffer, flush, stop } = createEventBuffer<Events>();

      preparedConnection = opts.prepareConnection({
        stream,
        mirror,
        preferredVideoCodec: preferredVideoCodec as VideoCodec | undefined,
        fps: resolveFpsNumber(options.model.fps),
        logger,
        observability: {
          telemetryEnabled: opts.telemetryEnabled,
          apiKey: credential,
          model: options.model.name,
          integration,
          logger,
          onDiagnostic: (event) => emitOrBuffer("diagnostic", event),
          onStats: (stats) => emitOrBuffer("stats", stats),
          onConnectionQuality: (report) => {
            emitOrBuffer("connectionQuality", report);
            onConnectionQuality?.(report);
          },
        },
      });
      observability = preparedConnection.observability;

      if (speed && !options.model.supportedSpeeds?.includes(speed)) {
        logger.warn(
          "realtime: model does not support the requested speed tier; the server serves it at standard speed",
          {
            model: options.model.name,
            speed,
            supportedSpeeds: options.model.supportedSpeeds ?? [],
          },
        );
      }

      // Captures only what a dial needs, not `options` (it lives as long as the session).
      const preparedQueryParams = preparedConnection.queryParams;
      const modelName = options.model.name;
      let dialCredential = credential;
      const dialUrl = (apiKey: string) => {
        dialCredential = apiKey;
        const queryParams = new URLSearchParams({
          ...preparedQueryParams,
          ...extraQueryParams,
          api_key: apiKey,
          model: modelName,
          ...(resolution ? { resolution } : {}),
          ...(speed ? { speed } : {}),
        });
        return `${url}?${queryParams.toString()}`;
      };

      session = new StreamSession({
        url: dialUrl(credential),
        redialUrl: () => {
          const next = nextCredential();
          return typeof next === "string" ? dialUrl(next) : next.then(dialUrl);
        },
        integration,
        observability,
        frameTiming: preparedConnection.frameTiming,
        localStream: preparedConnection.stream,
        initialImage,
        initialImageRef,
        initialPrompt,
        initialPassthrough: initialState?.passthrough,
        connectRetries: retries,
        logger,
        videoCodec: preparedConnection.videoCodec,
        remoteAudio,
        createMediaChannel: preparedConnection.createMediaChannel,
      });

      let sessionId: string | null = null;
      let subscribeToken: string | null = null;

      session.on("remoteStream", onRemoteStream);

      session.on("connectionChange", (state) => {
        emitOrBuffer("connectionChange", state);
        onConnectionChange?.(state);
      });

      session.on("queuePosition", (qp) => {
        emitOrBuffer("queuePosition", qp);
        onQueuePosition?.(qp);
      });

      session.on("sessionStarted", ({ sessionId: id, subscribeToken: token }) => {
        sessionId = id;
        subscribeToken = token;
        observability?.sessionStarted(id, dialCredential);
      });

      session.on("generationTick", (e) => emitOrBuffer("generationTick", e));
      session.on("generationEnded", (e) => emitOrBuffer("generationEnded", e));
      session.on("sessionEnded", (e) => emitOrBuffer("sessionEnded", e));

      session.on("error", (error) => {
        logger.error("Realtime error", { error: error.message });
        emitOrBuffer("error", classifyWebrtcError(error));
      });

      const activeSession = session;
      await activeSession.connect();

      const methods = realtimeMethods(activeSession, imageToBase64);

      const client: RealTimeClient = {
        ...methods,
        isConnected: () => activeSession.isConnected(),
        getConnectionState: () => activeSession.getConnectionState(),
        getConnectionQuality: () => observability?.getConnectionQuality() ?? null,
        disconnect: () => {
          observability?.stop();
          stop();
          activeSession.disconnect();
          preparedConnection?.dispose();
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
        setImage: async (image: Blob | File | string | null, imgOptions?: ImageSetOptions) => {
          if (isFileRefId(image)) {
            return activeSession.setImage({ kind: "ref", ref: image }, imgOptions);
          }
          if (image === null) return activeSession.setImage({ kind: "data", data: null }, imgOptions);
          const base64 = await imageToBase64(image);
          return activeSession.setImage({ kind: "data", data: base64 }, imgOptions);
        },
      };

      flush();
      return client;
    } catch (error) {
      observability?.stop();
      session?.disconnect();
      preparedConnection?.dispose();
      throw error instanceof DecartSDKException ? error.sdkError : error;
    }
  };

  return { connect };
};
