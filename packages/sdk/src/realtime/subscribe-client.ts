import type { RemoteParticipant, RemoteTrack, RemoteTrackPublication, Room } from "livekit-client";

import {
  classifyWebrtcError,
  createSDKError,
  type DecartSDKError,
  ERROR_CODES,
  isDecartSDKError,
} from "../utils/errors";
import { createConsoleLogger, type Logger } from "../utils/logger";
import { REALTIME_CONFIG } from "./config-realtime";
import { type ApiKeyProvider, createCredentialSource } from "./credential";
import { createEventBuffer } from "./event-buffer";
import { loadLiveKitClient } from "./livekit";
import type { DiagnosticEvent } from "./observability/diagnostics";
import { RealtimeObservability } from "./observability/realtime-observability";
import type { ConnectionState } from "./types";

type TokenPayload = {
  room_name: string;
  frame_timing?: boolean;
};

type WatchStreamResponse = {
  livekit_url: string;
  token: string;
  room_name: string;
};

type WatchStreamCredentialsRequest = {
  baseUrl: string;
  apiKey: string;
  roomName: string;
};

function createFrameMetadataSubscribeUnsupportedError(detail?: string): DecartSDKError {
  const suffix = detail ? `: ${detail}` : "";
  return createSDKError(
    ERROR_CODES.UNSUPPORTED_PLATFORM_FEATURE,
    `This realtime stream requires LiveKit frame metadata, which this SDK environment does not support${suffix}.`,
    { feature: "LiveKit frame metadata subscribe", platform: "this SDK environment" },
  );
}

export function decodeSubscribeToken(token: string): TokenPayload {
  try {
    const payload = JSON.parse(atob(token)) as Partial<TokenPayload>;
    if (!payload.room_name || typeof payload.room_name !== "string") {
      throw new Error("Invalid subscribe token format");
    }
    return { room_name: payload.room_name, ...(payload.frame_timing === true ? { frame_timing: true } : {}) };
  } catch {
    throw new Error("Invalid subscribe token");
  }
}

export type SubscribeEvents = {
  connectionChange: ConnectionState;
  error: DecartSDKError;
  diagnostic: DiagnosticEvent;
};

export type RealTimeSubscribeClient = {
  isConnected: () => boolean;
  getConnectionState: () => ConnectionState;
  disconnect: () => void;
  on: <K extends keyof SubscribeEvents>(event: K, listener: (data: SubscribeEvents[K]) => void) => void;
  off: <K extends keyof SubscribeEvents>(event: K, listener: (data: SubscribeEvents[K]) => void) => void;
};

/** The highest simulcast layer to receive; the SFU still drops lower when bandwidth requires. */
export type SubscribeVideoQuality = "low" | "medium" | "high";

export type SubscribeOptions = {
  token: string;
  onRemoteStream: (stream: MediaStream) => void;
  onConnectionChange?: (state: ConnectionState) => void;
  /**
   * Also receive the session's input: the tracks its publisher sends into the
   * room (camera, microphone), as a separate MediaStream re-emitted whenever
   * its track set changes. Omit it and the input is never downloaded.
   */
  onInputStream?: (stream: MediaStream) => void;
  /** Highest quality of the input video to receive, when `onInputStream` is set. Default `"high"`. */
  inputVideoQuality?: SubscribeVideoQuality;
};

export type RealTimeSubscribeClientOptions = {
  baseUrl: string;
  apiKey: string;
  /** Called before each subscribe for a fresh credential; wins over `apiKey`. */
  apiKeyProvider?: ApiKeyProvider;
  integration?: string;
  logger: Logger;
  createFrameMetadataWorker?: () => Worker;
  isFrameMetadataRuntimeSupported?: () => boolean;
};

function mapLiveKitState(state: string): ConnectionState {
  switch (state) {
    case "connecting":
      return "connecting";
    case "connected":
      return "connected";
    case "reconnecting":
    case "signalReconnecting":
      return "reconnecting";
    case "disconnected":
      return "disconnected";
    default:
      return "disconnected";
  }
}

/**
 * `stream`'s tracks plus `track`, as a fresh MediaStream. Consumers assign it to
 * an element's `srcObject`, and assigning the same reference is a no-op that
 * would leave a late-arriving audio track without a sink; a new object makes
 * the element re-read its tracks, so a single <video> plays video and audio.
 */
function withTrack(stream: MediaStream | null, track: MediaStreamTrack): MediaStream {
  const tracks = [...(stream?.getTracks() ?? [])];
  if (!tracks.includes(track)) {
    tracks.push(track);
  }
  return new MediaStream(tracks);
}

async function fetchWatchStreamCredentials(opts: WatchStreamCredentialsRequest): Promise<WatchStreamResponse> {
  if (!/^https?:\/\//i.test(opts.baseUrl)) {
    throw new Error(`watch-stream baseUrl must use http(s); got ${opts.baseUrl}`);
  }
  const url = `${opts.baseUrl}/watch-stream/${encodeURIComponent(opts.roomName)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "x-api-key": opts.apiKey,
      "content-type": "application/json",
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`watch-stream request failed (${res.status}): ${body || res.statusText}`);
  }
  const json = (await res.json()) as Partial<WatchStreamResponse>;
  if (!json.livekit_url || !json.token || !json.room_name) {
    throw new Error("watch-stream response missing required fields");
  }
  return { livekit_url: json.livekit_url, token: json.token, room_name: json.room_name };
}

export const createRealTimeSubscribeClient = (opts: RealTimeSubscribeClientOptions) => {
  const { baseUrl, integration } = opts;
  const logger = opts.logger ?? createConsoleLogger("info");
  const nextCredential = createCredentialSource({ apiKey: opts.apiKey, apiKeyProvider: opts.apiKeyProvider });

  const subscribe = async (options: SubscribeOptions): Promise<RealTimeSubscribeClient> => {
    const { room_name: roomName, frame_timing: frameTiming } = decodeSubscribeToken(options.token);
    const { emitter, emitOrBuffer, flush, stop } = createEventBuffer<SubscribeEvents>();

    let observability: RealtimeObservability | undefined;
    let room: Room | undefined;
    let frameMetadataWorker: Worker | undefined;
    let currentState: ConnectionState = "connecting";
    let remoteStream: MediaStream | null = null;
    let inputStream: MediaStream | null = null;

    const setState = (state: ConnectionState) => {
      if (currentState === state) return;
      currentState = state;
      options.onConnectionChange?.(state);
      emitOrBuffer("connectionChange", state);
    };

    // Outside the try: an expired client token is refused before anything is loaded or fetched, and
    // a provider rejection reaches the caller unchanged, as it does from `connect()`.
    const apiKey = await nextCredential();

    try {
      const liveKit = await loadLiveKitClient();
      const { Room: LiveKitRoom, RoomEvent } = liveKit;
      observability = new RealtimeObservability({
        telemetryEnabled: false,
        apiKey,
        integration,
        logger,
        onDiagnostic: (event) => emitOrBuffer("diagnostic", event),
      });

      setState("connecting");

      const creds = await fetchWatchStreamCredentials({ baseUrl, apiKey, roomName });

      // The publisher advertised frame timing, so the server appends a packet
      // trailer to every frame in this room. Without a strip worker the decoder
      // fails on every frame, so refuse the token rather than join and leave the
      // consumer staring at a permanently black video element.
      if (frameTiming) {
        if (!opts.createFrameMetadataWorker) {
          throw createFrameMetadataSubscribeUnsupportedError("this platform has no frame-metadata worker");
        }
        if (!(opts.isFrameMetadataRuntimeSupported?.() ?? false)) {
          throw createFrameMetadataSubscribeUnsupportedError(
            "encoded transforms are unavailable or the SDK is served cross-origin",
          );
        }
        try {
          frameMetadataWorker = opts.createFrameMetadataWorker();
        } catch (error) {
          throw createFrameMetadataSubscribeUnsupportedError(
            `failed to create the required worker (${error instanceof Error ? error.message : String(error)})`,
          );
        }
      }

      try {
        room = new LiveKitRoom({
          ...REALTIME_CONFIG.livekit.roomOptions,
          ...(frameMetadataWorker ? { frameMetadata: { worker: frameMetadataWorker } } : {}),
        });
      } catch (error) {
        frameMetadataWorker?.terminate();
        frameMetadataWorker = undefined;
        throw error;
      }
      const activeRoom = room;
      const { onInputStream } = options;
      // Read only when the input is wanted, so callers that never ask for it don't depend on the export.
      const inputVideoQuality = onInputStream
        ? {
            low: liveKit.VideoQuality.LOW,
            medium: liveKit.VideoQuality.MEDIUM,
            high: liveKit.VideoQuality.HIGH,
          }[options.inputVideoQuality ?? "high"]
        : undefined;
      const isInferenceServer = (participant: RemoteParticipant) =>
        participant.identity.startsWith(REALTIME_CONFIG.livekit.inferenceServerIdentityPrefix);

      // The room joins with `autoSubscribe: false` so only wanted tracks are
      // downloaded: the inference server's output always, the publisher's input
      // only when `onInputStream` asks for it. Publications already in the room
      // at join never emit TrackPublished and are swept after connect; a
      // livekit-internal full reconnect starts with no subscriptions, so sweep
      // again. `setSubscribed(true)` is idempotent.
      const subscribeIfWanted = (publication: RemoteTrackPublication, participant: RemoteParticipant) => {
        if (publication.kind !== "video" && publication.kind !== "audio") return;
        if (isInferenceServer(participant)) {
          publication.setSubscribed(true);
        } else if (onInputStream) {
          publication.setSubscribed(true);
          if (publication.kind === "video" && inputVideoQuality !== undefined) {
            publication.setVideoQuality(inputVideoQuality);
          }
        }
      };
      const subscribeExisting = () => {
        for (const participant of activeRoom.remoteParticipants.values()) {
          for (const publication of participant.trackPublications.values()) {
            subscribeIfWanted(publication as RemoteTrackPublication, participant);
          }
        }
      };
      activeRoom.on(RoomEvent.TrackPublished, subscribeIfWanted);
      activeRoom.on(RoomEvent.Reconnected, subscribeExisting);

      activeRoom.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _pub, participant: RemoteParticipant) => {
        if (track.kind !== "video" && track.kind !== "audio") return;
        const mediaStreamTrack = track.mediaStreamTrack;
        if (!mediaStreamTrack) return;

        if (isInferenceServer(participant)) {
          remoteStream = withTrack(remoteStream, mediaStreamTrack);
          options.onRemoteStream(remoteStream);
        } else if (onInputStream) {
          inputStream = withTrack(inputStream, mediaStreamTrack);
          onInputStream(inputStream);
        }
      });

      activeRoom.on(RoomEvent.ConnectionStateChanged, (state) => {
        setState(mapLiveKitState(state));
      });

      activeRoom.on(RoomEvent.Disconnected, () => {
        setState("disconnected");
      });

      await activeRoom.connect(creds.livekit_url, creds.token, { autoSubscribe: false });
      subscribeExisting();
      observability.setLiveKitRoom(activeRoom);
      setState("connected");

      const client: RealTimeSubscribeClient = {
        isConnected: () => activeRoom.state === "connected",
        getConnectionState: () => mapLiveKitState(activeRoom.state),
        disconnect: () => {
          observability?.stop();
          stop();
          // No explicit worker terminate: once the worker is handed to the Room,
          // LiveKit's FrameMetadataManager owns it and terminates it on
          // RoomEvent.Disconnected. Terminating here would double-free.
          activeRoom.disconnect().catch(() => {});
        },
        on: emitter.on,
        off: emitter.off,
      };

      flush();
      return client;
    } catch (error) {
      observability?.stop();
      if (room) {
        room.disconnect().catch(() => {});
      }
      frameMetadataWorker?.terminate();
      if (isDecartSDKError(error)) {
        logger.error("Realtime subscribe error", { error: error.message });
        throw error;
      }
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error("Realtime subscribe error", { error: err.message });
      throw classifyWebrtcError(err);
    }
  };

  return { subscribe };
};
