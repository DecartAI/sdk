/**
 * LiveKit connection for the realtime SDK.
 *
 * Control messages (prompt, set_image, session_id, generation_tick, acks)
 * flow over the Decart WebSocket; media is carried by a LiveKit room:
 *
 *   Client → bouncer WS: { type: "livekit_join" }
 *   bouncer/inference   → { type: "livekit_room_info", livekit_url, token, room_name }
 *   Client → LiveKit SFU: Room.connect(url, token) + publishTrack(...)
 */

import {
  ConnectionState as LKConnectionState,
  type RemoteParticipant,
  type RemoteTrack,
  Room,
  RoomEvent,
  Track,
  TrackEvent,
  type TrackPublishOptions,
} from "livekit-client";
import mitt from "mitt";

import { buildUserAgent } from "../utils/user-agent";
import type { RealtimeObservability } from "./observability/realtime-observability";
import type {
  ConnectionChangeDetails,
  ConnectionState,
  GenerationEndedMessage,
  GenerationTickMessage,
  IncomingRealtimeMessage,
  LiveKitRoomInfoMessage,
  OutgoingRealtimeMessage,
  PromptAckMessage,
  QueuePosition,
  SessionIdMessage,
  SetImageAckMessage,
} from "./types";

const INFERENCE_SERVER_IDENTITY_PREFIX = "inference-server-";

const SETUP_TIMEOUT_MS = 30_000;
const ROOM_INFO_TIMEOUT_MS = 15_000;
const DEFAULT_VIDEO_CODEC = "h264" as const;
const LOW_END_VIDEO_CODEC = "h264" as const;
const DEFAULT_MAX_VIDEO_BITRATE_BPS = 3_500_000;
export const LIVEKIT_ROOM_OPTIONS = {
  adaptiveStream: false,
  dynacast: false,
} as const;

type CodecSelectionRuntime = {
  window?: unknown;
  navigator?: {
    hardwareConcurrency?: number;
    deviceMemory?: number;
  };
};

function isLowEndBrowserDevice(runtime: CodecSelectionRuntime = globalThis): boolean {
  if (!runtime.window) return false;

  const { hardwareConcurrency, deviceMemory } = runtime.navigator ?? {};
  return (
    (typeof hardwareConcurrency === "number" && hardwareConcurrency <= 4) ||
    (typeof deviceMemory === "number" && deviceMemory <= 4)
  );
}

export function getDefaultVideoPublishOptions(runtime: CodecSelectionRuntime = globalThis): TrackPublishOptions {
  const videoEncoding = { maxBitrate: DEFAULT_MAX_VIDEO_BITRATE_BPS };
  if (isLowEndBrowserDevice(runtime)) {
    return {
      source: Track.Source.Camera,
      videoCodec: LOW_END_VIDEO_CODEC,
      videoEncoding,
    };
  }

  return {
    source: Track.Source.Camera,
    videoCodec: DEFAULT_VIDEO_CODEC,
    videoEncoding,
  };
}

interface LiveKitCallbacks {
  onRemoteStream?: (stream: MediaStream) => void;
  onStateChange?: (state: ConnectionState, details?: ConnectionChangeDetails) => void;
  onQueuePosition?: (queuePosition: QueuePosition) => void;
  onError?: (error: Error) => void;
  initialImage?: string;
  initialPrompt?: { text: string; enhance?: boolean };
  observability?: RealtimeObservability;
}

type WsMessageEvents = {
  promptAck: PromptAckMessage;
  setImageAck: SetImageAckMessage;
  sessionId: SessionIdMessage;
  roomInfo: LiveKitRoomInfoMessage;
  generationTick: GenerationTickMessage;
  generationEnded: GenerationEndedMessage;
};

export class LiveKitConnection {
  private ws: WebSocket | null = null;
  private room: Room | null = null;
  private localStream: MediaStream | null = null;
  private connectionReject: ((error: Error) => void) | null = null;
  private remoteStream: MediaStream | null = null;
  state: ConnectionState = "disconnected";
  websocketMessagesEmitter = mitt<WsMessageEvents>();

  constructor(private callbacks: LiveKitCallbacks = {}) {}

  async connect(url: string, localStream: MediaStream | null, timeout: number, integration?: string): Promise<void> {
    this.localStream = localStream;

    // Append user agent as a query parameter; browsers do not support WS headers.
    const userAgent = encodeURIComponent(buildUserAgent(integration));
    const separator = url.includes("?") ? "&" : "?";
    const wsUrl = `${url}${separator}user_agent=${userAgent}`;

    let rejectConnect!: (error: Error) => void;
    const connectAbort = new Promise<never>((_, reject) => {
      rejectConnect = reject;
    });
    connectAbort.catch(() => {});
    this.connectionReject = (error) => rejectConnect(error);

    try {
      // Phase 1 — control WS + livekit_join/livekit_room_info handshake.
      await Promise.race([this.openControlWs(wsUrl, timeout), connectAbort]);
      const roomInfo = await Promise.race([this.requestRoomInfo(), connectAbort]);
      this.setState("connecting");

      // Phase 2 — join the SFU room and publish local tracks.
      this.room = new Room(LIVEKIT_ROOM_OPTIONS);
      this.room.prepareConnection(roomInfo.livekit_url, roomInfo.token).catch(() => {});
      await Promise.race([this.joinRoom(roomInfo), connectAbort]);

      // Phase 3 — optional initial conditioning over the control WS.
      if (this.callbacks.initialImage) {
        await Promise.race([
          this.setImageBase64(this.callbacks.initialImage, {
            prompt: this.callbacks.initialPrompt?.text,
            enhance: this.callbacks.initialPrompt?.enhance,
          }),
          connectAbort,
        ]);
      } else if (this.callbacks.initialPrompt) {
        await Promise.race([this.sendInitialPrompt(this.callbacks.initialPrompt), connectAbort]);
      } else if (localStream) {
        await Promise.race([this.setImageBase64(null, { prompt: null }), connectAbort]);
      }

      this.setState("connected");
    } catch (error) {
      this.cleanup();
      throw error;
    } finally {
      this.connectionReject = null;
    }
  }

  send(message: OutgoingRealtimeMessage): boolean {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
      return true;
    }
    return false;
  }

  async setImageBase64(
    imageBase64: string | null,
    options?: { prompt?: string | null; enhance?: boolean; timeout?: number },
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.websocketMessagesEmitter.off("setImageAck", listener);
        reject(new Error("Image send timed out"));
      }, options?.timeout ?? SETUP_TIMEOUT_MS);

      const listener = (msg: SetImageAckMessage) => {
        clearTimeout(timeoutId);
        this.websocketMessagesEmitter.off("setImageAck", listener);
        if (msg.success) {
          resolve();
        } else {
          reject(new Error(msg.error ?? "Failed to send image"));
        }
      };
      this.websocketMessagesEmitter.on("setImageAck", listener);

      const message: {
        type: "set_image";
        image_data: string | null;
        prompt?: string | null;
        enhance_prompt?: boolean;
      } = { type: "set_image", image_data: imageBase64 };
      if (options?.prompt !== undefined) message.prompt = options.prompt;
      if (options?.enhance !== undefined) message.enhance_prompt = options.enhance;

      if (!this.send(message)) {
        clearTimeout(timeoutId);
        this.websocketMessagesEmitter.off("setImageAck", listener);
        reject(new Error("WebSocket is not open"));
      }
    });
  }

  cleanup(): void {
    this.setState("disconnected");
    if (this.room) {
      // Fire and forget — disconnect is async but we don't want to await
      // during cleanup paths.
      this.room.disconnect().catch(() => {});
      this.room = null;
    }
    this.callbacks.observability?.setLiveKitRoom(null);
    this.remoteStream = null;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
    this.localStream = null;
  }

  // -------------------------------------------------------------------------
  // Private — control WS
  // -------------------------------------------------------------------------

  private async openControlWs(wsUrl: string, timeout: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("WebSocket timeout")), timeout);
      this.ws = new WebSocket(wsUrl);
      this.ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      this.ws.onclose = (e) => {
        // If the room is still connecting this also aborts the connect flow.
        this.connectionReject?.(new Error(`WebSocket closed: ${e.code} ${e.reason}`));
        if (!this.room || this.room.state !== LKConnectionState.Connected) {
          this.setState("disconnected");
        }
      };
      this.ws.onerror = () => {
        // Error events don't carry details; onclose handles state transitions.
      };
      this.ws.onmessage = (e) => {
        try {
          this.handleControlMessage(JSON.parse(e.data));
        } catch {
          // Ignore malformed control messages; valid server errors use the `error` message type.
        }
      };
    });
  }

  private async requestRoomInfo(): Promise<LiveKitRoomInfoMessage> {
    this.send({ type: "livekit_join" });
    return await new Promise<LiveKitRoomInfoMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`livekit_room_info timeout (${ROOM_INFO_TIMEOUT_MS}ms)`));
      }, ROOM_INFO_TIMEOUT_MS);

      const handler = (msg: IncomingRealtimeMessage) => {
        if (msg.type === "livekit_room_info") {
          cleanup();
          resolve(msg);
        } else if (msg.type === "queue_position") {
          clearTimeout(timer);
          const queuePosition = {
            position: msg.position,
            queueSize: msg.queue_size,
          };
          this.setState("pending", { queuePosition });
          this.callbacks.onQueuePosition?.(queuePosition);
        } else if (msg.type === "error") {
          cleanup();
          reject(new Error(msg.error));
        }
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.pendingRoomInfoResolvers = this.pendingRoomInfoResolvers.filter((h) => h !== handler);
      };
      this.pendingRoomInfoResolvers.push(handler);
    });
  }

  private pendingRoomInfoResolvers: Array<(msg: IncomingRealtimeMessage) => void> = [];

  private handleControlMessage(msg: IncomingRealtimeMessage): void {
    // First give pending livekit_room_info awaiters a chance.
    for (const resolver of [...this.pendingRoomInfoResolvers]) {
      resolver(msg);
    }

    // Then fan out control-plane acks to the public realtime client.
    switch (msg.type) {
      case "prompt_ack":
        this.websocketMessagesEmitter.emit("promptAck", msg);
        break;
      case "set_image_ack":
        this.websocketMessagesEmitter.emit("setImageAck", msg);
        break;
      case "session_id":
        this.websocketMessagesEmitter.emit("sessionId", msg);
        break;
      case "livekit_room_info":
        this.websocketMessagesEmitter.emit("roomInfo", msg);
        break;
      case "generation_tick":
        this.websocketMessagesEmitter.emit("generationTick", msg);
        break;
      case "generation_ended":
        this.websocketMessagesEmitter.emit("generationEnded", msg);
        break;
      case "error": {
        const error = new Error(msg.error) as Error & { source?: string };
        error.source = "server";
        this.callbacks.onError?.(error);
        this.connectionReject?.(error);
        break;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Private — LiveKit room
  // -------------------------------------------------------------------------

  private async joinRoom(info: LiveKitRoomInfoMessage): Promise<void> {
    this.room ??= new Room(LIVEKIT_ROOM_OPTIONS);

    this.room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _publication, participant: RemoteParticipant) => {
      if (!participant.identity.startsWith(INFERENCE_SERVER_IDENTITY_PREFIX)) return;
      if (track.kind === Track.Kind.Video || track.kind === Track.Kind.Audio) {
        track.attach();
        const mediaStreamTrack = track.mediaStreamTrack;
        if (mediaStreamTrack) {
          this.remoteStream ??= new MediaStream();
          if (!this.remoteStream.getTracks().includes(mediaStreamTrack)) {
            this.remoteStream.addTrack(mediaStreamTrack);
          }
          this.callbacks.onRemoteStream?.(this.remoteStream);
        }
        track.on(TrackEvent.VideoPlaybackStarted, () => {
          this.setState("generating");
        });
      }
    });

    this.room.on(RoomEvent.Disconnected, () => {
      this.setState("disconnected");
    });

    await this.room.connect(info.livekit_url, info.token);

    this.callbacks.observability?.setLiveKitRoom(this.room);

    if (this.localStream) {
      await this.publishLocalTracks(this.localStream);
    }
  }

  private async publishLocalTracks(stream: MediaStream): Promise<void> {
    if (!this.room) return;
    for (const track of stream.getTracks()) {
      if (track.kind === "video") {
        const publishOptions = getDefaultVideoPublishOptions();
        await this.room.localParticipant.publishTrack(track, publishOptions);
      } else {
        await this.room.localParticipant.publishTrack(track);
      }
    }
  }

  private async sendInitialPrompt(prompt: { text: string; enhance?: boolean }): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.websocketMessagesEmitter.off("promptAck", listener);
        reject(new Error("Prompt send timed out"));
      }, SETUP_TIMEOUT_MS);

      const listener = (msg: PromptAckMessage) => {
        if (msg.prompt === prompt.text) {
          clearTimeout(timeoutId);
          this.websocketMessagesEmitter.off("promptAck", listener);
          if (msg.success) {
            resolve();
          } else {
            reject(new Error(msg.error ?? "Failed to send prompt"));
          }
        }
      };
      this.websocketMessagesEmitter.on("promptAck", listener);

      const message: OutgoingRealtimeMessage = {
        type: "prompt",
        prompt: prompt.text,
        enhance_prompt: prompt.enhance ?? true,
      };

      if (!this.send(message)) {
        clearTimeout(timeoutId);
        this.websocketMessagesEmitter.off("promptAck", listener);
        reject(new Error("WebSocket is not open"));
      }
    });
  }

  private setState(state: ConnectionState, details?: ConnectionChangeDetails): void {
    const shouldEmit = this.state !== state || (state === "pending" && details?.queuePosition !== undefined);
    if (shouldEmit) {
      this.state = state;
      this.callbacks.onStateChange?.(state, details);
    }
  }
}
