import {
  ConnectionState as LiveKitConnectionState,
  type RemoteParticipant,
  type RemoteTrack,
  Room,
  RoomEvent,
  Track,
} from "livekit-client";

import { classifyWebrtcError, type DecartSDKError } from "../utils/errors";
import { createConsoleLogger, type Logger } from "../utils/logger";
import { REALTIME_CONFIG } from "./config-realtime";
import { createEventBuffer } from "./event-buffer";
import type { DiagnosticEvent } from "./observability/diagnostics";
import { RealtimeObservability } from "./observability/realtime-observability";
import type { ConnectionState } from "./types";

type TokenPayload = {
  room_name: string;
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

export function decodeSubscribeToken(token: string): TokenPayload {
  try {
    const payload = JSON.parse(atob(token)) as Partial<TokenPayload>;
    if (!payload.room_name || typeof payload.room_name !== "string") {
      throw new Error("Invalid subscribe token format");
    }
    return { room_name: payload.room_name };
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

export type SubscribeOptions = {
  token: string;
  onRemoteStream: (stream: MediaStream) => void;
  onConnectionChange?: (state: ConnectionState) => void;
  /**
   * Play remote audio tracks. Default `false`.
   *
   * When `false`, any audio the model emits is dropped on the client — no
   * playback element is attached and audio is not added to the stream
   * passed to `onRemoteStream`. Set `true` when the model emits audio you
   * want the viewer to hear.
   */
  playRemoteAudio?: boolean;
};

export type RealTimeSubscribeClientOptions = {
  baseUrl: string;
  apiKey: string;
  integration?: string;
  logger: Logger;
};

function mapLiveKitState(state: LiveKitConnectionState): ConnectionState {
  switch (state) {
    case LiveKitConnectionState.Connecting:
      return "connecting";
    case LiveKitConnectionState.Connected:
      return "connected";
    case LiveKitConnectionState.Reconnecting:
    case LiveKitConnectionState.SignalReconnecting:
      return "reconnecting";
    case LiveKitConnectionState.Disconnected:
      return "disconnected";
    default:
      return "disconnected";
  }
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
  const { baseUrl, apiKey, integration } = opts;
  const logger = opts.logger ?? createConsoleLogger("info");

  const subscribe = async (options: SubscribeOptions): Promise<RealTimeSubscribeClient> => {
    const { room_name: roomName } = decodeSubscribeToken(options.token);
    const { emitter, emitOrBuffer, flush, stop } = createEventBuffer<SubscribeEvents>();

    let observability: RealtimeObservability | undefined;
    let room: Room | undefined;
    let currentState: ConnectionState = "connecting";
    let remoteStream: MediaStream | null = null;

    const setState = (state: ConnectionState) => {
      if (currentState === state) return;
      currentState = state;
      options.onConnectionChange?.(state);
      emitOrBuffer("connectionChange", state);
    };

    try {
      observability = new RealtimeObservability({
        telemetryEnabled: false,
        apiKey,
        integration,
        logger,
        onDiagnostic: (event) => emitOrBuffer("diagnostic", event),
      });

      setState("connecting");

      const creds = await fetchWatchStreamCredentials({ baseUrl, apiKey, roomName });

      room = new Room(REALTIME_CONFIG.livekit.roomOptions);
      const activeRoom = room;

      activeRoom.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _pub, participant: RemoteParticipant) => {
        if (!participant.identity.startsWith(REALTIME_CONFIG.livekit.inferenceServerIdentityPrefix)) return;
        if (track.kind !== Track.Kind.Video && track.kind !== Track.Kind.Audio) return;
        if (track.kind === Track.Kind.Audio && !options.playRemoteAudio) return;

        track.attach();
        const mediaStreamTrack = track.mediaStreamTrack;
        if (!mediaStreamTrack) return;
        remoteStream ??= new MediaStream();
        if (!remoteStream.getTracks().includes(mediaStreamTrack)) {
          remoteStream.addTrack(mediaStreamTrack);
        }
        options.onRemoteStream(remoteStream);
      });

      activeRoom.on(RoomEvent.ConnectionStateChanged, (state) => {
        setState(mapLiveKitState(state));
      });

      activeRoom.on(RoomEvent.Disconnected, () => {
        setState("disconnected");
      });

      await activeRoom.connect(creds.livekit_url, creds.token);
      observability.setLiveKitRoom(activeRoom);
      setState("connected");

      const client: RealTimeSubscribeClient = {
        isConnected: () => activeRoom.state === LiveKitConnectionState.Connected,
        getConnectionState: () => mapLiveKitState(activeRoom.state),
        disconnect: () => {
          observability?.stop();
          stop();
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
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error("Realtime subscribe error", { error: err.message });
      throw classifyWebrtcError(err);
    }
  };

  return { subscribe };
};
