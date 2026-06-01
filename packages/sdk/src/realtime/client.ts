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
import type { RoomOptions, TrackPublishOptions } from "livekit-client";

import type { RealtimeVideoStats } from "./media-channel";

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
  publishOptions: z
    .custom<Partial<TrackPublishOptions>>((val) => val === undefined || typeof val === "object")
    .optional(),
  roomOptions: z.custom<Partial<RoomOptions>>((val) => val === undefined || typeof val === "object").optional(),
  remoteVideoElement: z
    .custom<HTMLVideoElement>(
      (val) => val === undefined || (typeof val === "object" && val !== null && "srcObject" in val),
    )
    .optional(),
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
  getVideoStats: () => Promise<RealtimeVideoStats>;
};

export const createRealTimeClient = (opts: RealTimeClientOptions) => {
  const { baseUrl, apiKey, integration } = opts;
  const logger = opts.logger ?? createConsoleLogger("info");

  const connect = async (
    stream: MediaStream | null,
    options: RealTimeClientConnectOptions,
  ): Promise<RealTimeClient> => {
    const parsedOptions = realTimeClientConnectOptionsSchema.safeParse(options);
    if (!parsedOptions.success) throw parsedOptions.error;

    const {
      onRemoteStream,
      onConnectionChange,
      onQueuePosition,
      initialState,
      resolution,
      publishOptions,
      roomOptions,
      remoteVideoElement,
    } = parsedOptions.data;
    const mirror = parsedOptions.data.mirror ?? false;
    let inputStream: MediaStream = stream ?? new MediaStream();

    let mirroredStream: MirroredStream | undefined;
    if (mirror !== false) {
      try {
        const firstVideoTrack = inputStream.getVideoTracks?.()[0];
        if (firstVideoTrack && (mirror === true || shouldMirrorTrack(firstVideoTrack))) {
          mirroredStream = createMirroredStream(inputStream, { fps: resolveFpsNumber(options.model.fps) });
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

    let session: StreamSession | undefined;
    let observability: RealtimeObservability | undefined;

    try {
      const initialImageRef = isFileRefId(initialState?.image) ? initialState.image : undefined;
      const initialImage =
        initialImageRef === undefined && initialState?.image ? await imageToBase64(initialState.image) : undefined;
      const initialPrompt = initialState?.prompt
        ? { text: initialState.prompt.text, enhance: initialState.prompt.enhance }
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

      const safariCodec = isDesktopSafari() ? "vp8" : undefined;
      const publishCodec: VideoCodec | undefined = safariCodec ?? preferredVideoCodec;

      const queryParams = new URLSearchParams({
        ...(safariCodec ? { livekit_server_codec: safariCodec } : {}),
        livekit_early_room_info: "true",
        ...(options.queryParams ?? {}),
        api_key: apiKey,
        model: options.model.name,
        ...(resolution ? { resolution } : {}),
      });

      session = new StreamSession({
        url: `${url}?${queryParams.toString()}`,
        integration,
        observability,
        localStream: inputStream,
        initialImage,
        initialImageRef,
        initialPrompt,
        logger,
        videoCodec: safariCodec,
        publishOptions,
        roomOptions,
        remoteVideoElement,
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
        observability?.sessionStarted(id);
      });

      session.on("generationTick", (e) => emitOrBuffer("generationTick", e));
      session.on("generationEnded", (e) => emitOrBuffer("generationEnded", e));

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
        disconnect: () => {
          observability?.stop();
          stop();
          activeSession.disconnect();
          mirroredStream?.dispose();
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
        getVideoStats: () => activeSession.getVideoStats(),
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
      mirroredStream?.dispose();
      throw error;
    }
  };

  return { connect };
};
