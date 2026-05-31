import { z } from "zod";
import { isFileRefId } from "../files/types";
import {
  type CustomModelDefinition,
  type ModelDefinition,
  modelDefinitionSchema,
  resolveFpsNumber,
} from "../shared/model";
import { modelStateSchema } from "../shared/types";
import { classifyWebrtcError, type DecartSDKError } from "../utils/errors";
import { createConsoleLogger, type Logger } from "../utils/logger";
import { imageToBase64 } from "../utils/media";
import { isDesktopSafari } from "../utils/platform";
import { createEventBuffer } from "./event-buffer";
import type { VideoCodec } from "./media-channel";
import { realtimeMethods, type SetInput } from "./methods";
import { createMirroredStream, type MirroredStream, shouldMirrorTrack } from "./mirror-stream";
import type { DiagnosticEvent } from "./observability/diagnostics";
import { RealtimeObservability } from "./observability/realtime-observability";
import type { WebRTCStats } from "./observability/webrtc-stats";
import { StreamSession } from "./stream-session";
import type { ConnectionState, GenerationEnded, GenerationTick, ImageSetOptions, QueuePosition } from "./types";

export type RealTimeClientOptions = {
  baseUrl: string;
  apiKey: string;
  integration?: string;
  logger: Logger;
  telemetryEnabled: boolean;
};

const realTimeClientInitialStateSchema = modelStateSchema;
type OnRemoteStreamFn = (stream: MediaStream) => void;
type OnConnectionChangeFn = (state: ConnectionState) => void;
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
  mirror: z.union([z.literal("auto"), z.boolean()]).optional(),
  resolution: z.enum(["720p", "1080p"]).optional(),
  /** Local track publish codec. Desktop Safari is always pinned to vp8 and ignores this value. */
  preferredVideoCodec: z.enum(["h264", "vp9"]).optional(),
});
export type RealTimeClientConnectOptions = Omit<z.infer<typeof realTimeClientConnectOptionsSchema>, "model"> & {
  model: ModelDefinition | CustomModelDefinition;
};

export type Events = {
  connectionChange: ConnectionState;
  queuePosition: QueuePosition;
  error: DecartSDKError;
  generationTick: GenerationTick;
  generationEnded: GenerationEnded;
  diagnostic: DiagnosticEvent;
  stats: WebRTCStats;
};
type EventBuffer = ReturnType<typeof createEventBuffer<Events>>;

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
  /**
   * Set the reference image for the session.
   * - `Blob`/`File`/data URL/http(s) URL/base64 string: bytes traverse the wire as base64.
   * - `"file_..."` id (from `client.files.upload(...).id`): sent as a server-side reference.
   * - `null`: clear the current image.
   */
  setImage: (image: Blob | File | string | null, options?: ImageSetOptions) => Promise<void>;
};

export type RealTimeWarmupClient = {
  start: (stream: MediaStream) => Promise<RealTimeClient>;
  isConnected: () => boolean;
  getConnectionState: () => ConnectionState;
  disconnect: () => void;
  on: <K extends keyof Events>(event: K, listener: (data: Events[K]) => void) => void;
  off: <K extends keyof Events>(event: K, listener: (data: Events[K]) => void) => void;
  sessionId: string | null;
  subscribeToken: string | null;
  getSubscribeToken: () => string | null;
};

export const createRealTimeClient = (opts: RealTimeClientOptions) => {
  const { baseUrl, apiKey, integration } = opts;
  const logger = opts.logger ?? createConsoleLogger("info");

  const prepareInputStream = (
    stream: MediaStream | null,
    mirror: "auto" | boolean,
    fps: number,
  ): { inputStream: MediaStream; dispose: () => void } => {
    let inputStream: MediaStream = stream ?? new MediaStream();
    let mirroredStream: MirroredStream | undefined;

    if (mirror !== false) {
      try {
        const firstVideoTrack = inputStream.getVideoTracks?.()[0];
        if (firstVideoTrack && (mirror === true || shouldMirrorTrack(firstVideoTrack))) {
          mirroredStream = createMirroredStream(inputStream, { fps });
          inputStream = mirroredStream.stream;
        } else if (mirror === true && !firstVideoTrack) {
          logger.warn("mirror: true requested but no video track was found on the input stream");
        }
      } catch (error) {
        logger.warn("Failed to mirror input stream; falling back to un-mirrored input", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      inputStream,
      dispose: () => mirroredStream?.dispose(),
    };
  };

  type ParsedConnectOptions = z.infer<typeof realTimeClientConnectOptionsSchema>;

  const createClientHandle = ({
    activeSession,
    eventEmitter,
    stop,
    observability,
    getSessionId,
    getSubscribeToken,
    disposeInput,
  }: {
    activeSession: StreamSession;
    eventEmitter: EventBuffer["emitter"];
    stop: () => void;
    observability: RealtimeObservability;
    getSessionId: () => string | null;
    getSubscribeToken: () => string | null;
    disposeInput: () => void;
  }): RealTimeClient => {
    const methods = realtimeMethods(activeSession, imageToBase64);

    return {
      ...methods,
      isConnected: () => activeSession.isConnected(),
      getConnectionState: () => activeSession.getConnectionState(),
      disconnect: () => {
        observability.stop();
        stop();
        activeSession.disconnect();
        disposeInput();
      },
      on: eventEmitter.on,
      off: eventEmitter.off,
      get sessionId() {
        return getSessionId();
      },
      get subscribeToken() {
        return getSubscribeToken();
      },
      getSubscribeToken,
      setImage: async (image: Blob | File | string | null, imgOptions?: ImageSetOptions) => {
        if (isFileRefId(image)) {
          return activeSession.setImage({ kind: "ref", ref: image }, imgOptions);
        }
        if (image === null) return activeSession.setImage({ kind: "data", data: null }, imgOptions);
        const base64 = await imageToBase64(image);
        return activeSession.setImage({ kind: "data", data: base64 }, imgOptions);
      },
    };
  };

  const openSession = async ({
    localStream,
    options,
    parsedOptions,
    livekitWarmup,
  }: {
    localStream: MediaStream | null;
    options: RealTimeClientConnectOptions;
    parsedOptions: ParsedConnectOptions;
    livekitWarmup: boolean;
  }) => {
    const { onRemoteStream, onConnectionChange, onQueuePosition, initialState, resolution, preferredVideoCodec } =
      parsedOptions;

    const initialImageRef = isFileRefId(initialState?.image) ? initialState.image : undefined;
    const initialImage =
      initialImageRef === undefined && initialState?.image ? await imageToBase64(initialState.image) : undefined;
    const initialPrompt = initialState?.prompt
      ? { text: initialState.prompt.text, enhance: initialState.prompt.enhance }
      : undefined;

    const url = `${baseUrl}${options.model.urlPath}`;
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

    const safariCodec = isDesktopSafari() ? "vp8" : undefined;
    const publishCodec: VideoCodec | undefined = safariCodec ?? preferredVideoCodec;

    const queryParams = new URLSearchParams({
      ...(safariCodec ? { livekit_server_codec: safariCodec } : {}),
      ...(options.queryParams ?? {}),
      ...(livekitWarmup ? { livekit_warmup: "1" } : {}),
      api_key: apiKey,
      model: options.model.name,
      ...(resolution ? { resolution } : {}),
    });

    const session = new StreamSession({
      url: `${url}?${queryParams.toString()}`,
      integration,
      observability,
      localStream,
      initialImage,
      initialImageRef,
      initialPrompt,
      logger,
      videoCodec: publishCodec,
      waitForInitialStateAck: !livekitWarmup,
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
      observability.sessionStarted(id);
    });

    session.on("generationTick", (e) => emitOrBuffer("generationTick", e));
    session.on("generationEnded", (e) => emitOrBuffer("generationEnded", e));

    session.on("error", (error) => {
      logger.error("Realtime error", { error: error.message });
      emitOrBuffer("error", classifyWebrtcError(error));
    });

    try {
      await session.connect();
    } catch (error) {
      observability.stop();
      session.disconnect();
      stop();
      throw error;
    }

    return {
      activeSession: session,
      eventEmitter,
      flush,
      stop,
      observability,
      getSessionId: () => sessionId,
      getSubscribeToken: () => subscribeToken,
    };
  };

  const connect = async (
    stream: MediaStream | null,
    options: RealTimeClientConnectOptions,
  ): Promise<RealTimeClient> => {
    const parsedOptions = realTimeClientConnectOptionsSchema.safeParse(options);
    if (!parsedOptions.success) throw parsedOptions.error;

    const mirror = parsedOptions.data.mirror ?? false;
    const prepared = prepareInputStream(stream, mirror, resolveFpsNumber(parsedOptions.data.model.fps));

    try {
      const sessionContext = await openSession({
        localStream: prepared.inputStream,
        options,
        parsedOptions: parsedOptions.data,
        livekitWarmup: false,
      });

      const client = createClientHandle({
        ...sessionContext,
        disposeInput: prepared.dispose,
      });
      sessionContext.flush();
      return client;
    } catch (error) {
      prepared.dispose();
      throw error;
    }
  };

  const warmup = async (options: RealTimeClientConnectOptions): Promise<RealTimeWarmupClient> => {
    const parsedOptions = realTimeClientConnectOptionsSchema.safeParse(options);
    if (!parsedOptions.success) throw parsedOptions.error;

    const sessionContext = await openSession({
      localStream: null,
      options,
      parsedOptions: parsedOptions.data,
      livekitWarmup: true,
    });

    let started = false;
    let disposeStartedInput: (() => void) | undefined;
    const mirror = parsedOptions.data.mirror ?? false;

    const disconnect = () => {
      sessionContext.observability.stop();
      sessionContext.stop();
      sessionContext.activeSession.disconnect();
      disposeStartedInput?.();
    };

    const warmupClient: RealTimeWarmupClient = {
      start: async (stream: MediaStream) => {
        if (started) {
          throw new Error("Realtime warmup has already been started");
        }
        started = true;
        const prepared = prepareInputStream(stream, mirror, resolveFpsNumber(parsedOptions.data.model.fps));
        disposeStartedInput = prepared.dispose;
        try {
          await sessionContext.activeSession.publishLocalStream(prepared.inputStream);
        } catch (error) {
          prepared.dispose();
          throw error;
        }
        return createClientHandle({
          ...sessionContext,
          disposeInput: () => {
            prepared.dispose();
          },
        });
      },
      isConnected: () => sessionContext.activeSession.isConnected(),
      getConnectionState: () => sessionContext.activeSession.getConnectionState(),
      disconnect,
      on: sessionContext.eventEmitter.on,
      off: sessionContext.eventEmitter.off,
      get sessionId() {
        return sessionContext.getSessionId();
      },
      get subscribeToken() {
        return sessionContext.getSubscribeToken();
      },
      getSubscribeToken: sessionContext.getSubscribeToken,
    };

    sessionContext.flush();
    return warmupClient;
  };

  return { connect, warmup };
};
