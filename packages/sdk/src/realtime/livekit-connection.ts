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
  type LocalTrack,
  type RemoteTrack,
  Room,
  RoomEvent,
  Track,
  TrackEvent,
  type TrackPublishOptions,
} from "livekit-client";
import mitt from "mitt";

import type { Logger } from "../utils/logger";
import { buildUserAgent } from "../utils/user-agent";
import type { DiagnosticEmitter } from "./diagnostics";
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
import type { StatsProvider } from "./webrtc-stats";

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
  modelName?: string;
  initialImage?: string;
  initialPrompt?: { text: string; enhance?: boolean };
  logger?: Logger;
  onDiagnostic?: DiagnosticEmitter;
}

type WsMessageEvents = {
  promptAck: PromptAckMessage;
  setImageAck: SetImageAckMessage;
  sessionId: SessionIdMessage;
  roomInfo: LiveKitRoomInfoMessage;
  generationTick: GenerationTickMessage;
  generationEnded: GenerationEndedMessage;
};

const noopDiagnostic: DiagnosticEmitter = () => {};

export class LiveKitConnection {
  private ws: WebSocket | null = null;
  private room: Room | null = null;
  private localStream: MediaStream | null = null;
  private connectionReject: ((error: Error) => void) | null = null;
  private logger: Logger;
  private emitDiagnostic: DiagnosticEmitter;
  private statsProvider: StatsProvider | null = null;
  private remoteStream: MediaStream | null = null;
  private lastServerError: string | null = null;
  state: ConnectionState = "disconnected";
  websocketMessagesEmitter = mitt<WsMessageEvents>();
  private startupMarks: Map<string, number> = new Map();
  private startupEmitted = false;

  constructor(private callbacks: LiveKitCallbacks = {}) {
    this.logger = callbacks.logger ?? { debug() {}, info() {}, warn() {}, error() {} };
    this.emitDiagnostic = callbacks.onDiagnostic ?? noopDiagnostic;
  }

  private startupMark(name: string): void {
    if (this.startupEmitted || this.startupMarks.has(name)) return;
    this.startupMarks.set(name, performance.now());
  }

  private emitStartupBreakdown(): void {
    if (this.startupEmitted) return;
    this.startupEmitted = true;
    const m = this.startupMarks;
    const delta = (a: string, b: string): number | null => {
      const ta = m.get(a);
      const tb = m.get(b);
      if (ta === undefined || tb === undefined) return null;
      return Math.round((tb - ta) * 100) / 100;
    };
    this.logger.info("livekit_client_startup_breakdown", {
      ws_open_ms: delta("connect_start", "ws_open"),
      room_info_ms: delta("ws_open", "room_info_received"),
      prepare_connection_ms: delta("room_info_received", "prepare_connection_done"),
      room_connect_ms: delta("room_info_received", "room_connect_done"),
      publish_local_track_ms: delta("room_connect_done", "publish_local_track_done"),
      remote_track_announced_ms: delta("room_connect_done", "first_remote_track_subscribed"),
      first_frame_after_remote_track_ms: delta("first_remote_track_subscribed", "first_frame_received"),
      total_perceived_ttff_ms: delta("connect_start", "first_frame_received"),
    });
  }

  /**
   * Stats provider for the LiveKit connection. Aggregates
   * `track.getRTCStatsReport()` from every local (outbound) and remote
   * (inbound) track in the room into a single RTCStatsReport-compatible
   * Map. That's the minimum surface WebRTCStatsCollector.parse() needs —
   * it calls `.forEach` and keys off `report.type`.
   */
  getStatsProvider(): StatsProvider | null {
    return this.statsProvider;
  }

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
      this.startupMark("connect_start");
      // Phase 1 — control WS + livekit_join/livekit_room_info handshake.
      const roomInfoStart = performance.now();
      await Promise.race([this.openControlWs(wsUrl, timeout), connectAbort]);
      this.startupMark("ws_open");
      const roomInfo = await Promise.race([this.requestRoomInfo(), connectAbort]);
      this.startupMark("room_info_received");
      this.setState("connecting");
      this.emitDiagnostic("phaseTiming", {
        phase: "websocket",
        durationMs: performance.now() - roomInfoStart,
        success: true,
      });

      // Phase 2 — join the SFU room and publish local tracks.
      const roomStart = performance.now();
      this.room = new Room(LIVEKIT_ROOM_OPTIONS);
      this.room
        .prepareConnection(roomInfo.livekit_url, roomInfo.token)
        .then(() => this.startupMark("prepare_connection_done"))
        .catch(() => {});
      await Promise.race([this.joinRoom(roomInfo), connectAbort]);
      this.emitDiagnostic("phaseTiming", {
        phase: "webrtc-handshake",
        durationMs: performance.now() - roomStart,
        success: true,
      });

      // Phase 3 — optional startup conditioning over the control WS.
      if (this.callbacks.initialImage) {
        const imageStart = performance.now();
        await Promise.race([
          this.setImageBase64(this.callbacks.initialImage, {
            prompt: this.callbacks.initialPrompt?.text,
            enhance: this.callbacks.initialPrompt?.enhance,
          }),
          connectAbort,
        ]);
        this.emitDiagnostic("phaseTiming", {
          phase: "initial-image",
          durationMs: performance.now() - imageStart,
          success: true,
        });
      } else if (this.callbacks.initialPrompt) {
        const promptStart = performance.now();
        await Promise.race([this.sendInitialPrompt(this.callbacks.initialPrompt), connectAbort]);
        this.emitDiagnostic("phaseTiming", {
          phase: "initial-prompt",
          durationMs: performance.now() - promptStart,
          success: true,
        });
      } else if (localStream) {
        const passthroughStart = performance.now();
        await Promise.race([this.setImageBase64(null, { prompt: null }), connectAbort]);
        this.emitDiagnostic("phaseTiming", {
          phase: "initial-prompt",
          durationMs: performance.now() - passthroughStart,
          success: true,
        });
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
    this.statsProvider = null;
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
      this.lastServerError = null;
      this.ws = new WebSocket(wsUrl);
      this.ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      this.ws.onclose = (e) => {
        const details = {
          code: e.code,
          reason: e.reason || this.lastServerError || "(none)",
          wasClean: e.wasClean,
          serverError: this.lastServerError,
        };
        if (this.state !== "disconnected" || this.lastServerError) {
          this.logger.warn("LiveKit control WS closed unexpectedly", details);
        }
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
        } catch (error) {
          this.logger.error("LiveKit control WS message parse error", {
            error: String(error),
            preview: typeof e.data === "string" ? e.data.slice(0, 200) : "(non-string)",
          });
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
          this.logger.info("LiveKit join queued", {
            position: queuePosition.position,
            queueSize: queuePosition.queueSize,
          });
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
        if (msg.reason && msg.reason !== "disconnect") {
          this.lastServerError = msg.reason;
        }
        this.websocketMessagesEmitter.emit("generationEnded", msg);
        break;
      case "error": {
        this.lastServerError = msg.error ?? null;
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

    this.room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
      if (track.kind === Track.Kind.Video || track.kind === Track.Kind.Audio) {
        if (track.kind === Track.Kind.Video) {
          this.startupMark("first_remote_track_subscribed");
        }
        const attachedElement = track.attach();
        const mediaStreamTrack = track.mediaStreamTrack;
        if (mediaStreamTrack) {
          this.remoteStream ??= new MediaStream();
          if (!this.remoteStream.getTracks().includes(mediaStreamTrack)) {
            this.remoteStream.addTrack(mediaStreamTrack);
          }
        }

        let fired = false;
        const fireFirstFrame = () => {
          if (fired) return;
          fired = true;
          this.startupMark("first_frame_received");
          this.emitStartupBreakdown();
          if (this.remoteStream) {
            this.callbacks.onRemoteStream?.(this.remoteStream);
          }
          this.setState("generating");
        };

        const isVideoElement =
          track.kind === Track.Kind.Video &&
          typeof HTMLVideoElement !== "undefined" &&
          attachedElement instanceof HTMLVideoElement;
        if (isVideoElement && "requestVideoFrameCallback" in attachedElement) {
          (attachedElement as HTMLVideoElement).requestVideoFrameCallback(() => fireFirstFrame());
          setTimeout(fireFirstFrame, 5000);
        } else {
          track.on(TrackEvent.VideoPlaybackStarted, fireFirstFrame);
        }
      }
    });

    this.room.on(RoomEvent.Disconnected, () => {
      this.setState("disconnected");
    });

    await this.room.connect(info.livekit_url, info.token);
    this.startupMark("room_connect_done");

    // Wire up the stats provider now that the room has local+remote
    // participant objects available. Held by reference here so the SDK
    // client's identity-check in handleConnectionStateChange() sees a
    // stable provider for this room.
    this.statsProvider = createLiveKitStatsProvider(this.room);

    if (this.localStream) {
      await this.publishLocalTracks(this.localStream);
      this.startupMark("publish_local_track_done");
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

function createLiveKitStatsProvider(room: Room): StatsProvider {
  let uid = 0;

  const collectFromTrack = async (
    track: LocalTrack | RemoteTrack | undefined,
    entries: Array<[string, unknown]>,
  ): Promise<void> => {
    if (!track) return;
    let report: RTCStatsReport | undefined;
    try {
      report = await track.getRTCStatsReport();
    } catch {
      // Track is likely unmuted/unattached or the PC is mid-teardown — skip it.
      return;
    }
    if (!report) return;
    report.forEach((stat, id) => {
      entries.push([`${id}#${uid++}`, stat]);
    });
  };

  return {
    async getStats(): Promise<RTCStatsReport> {
      const entries: Array<[string, unknown]> = [];

      // Outbound: the local participant's published tracks (what we send to
      // the SFU — the server reads these as its inbound video/audio).
      for (const pub of room.localParticipant.trackPublications.values()) {
        await collectFromTrack(pub.track, entries);
      }

      for (const participant of room.remoteParticipants.values()) {
        for (const pub of participant.trackPublications.values()) {
          await collectFromTrack(pub.track as RemoteTrack | undefined, entries);
        }
      }

      // `Map` is structurally compatible with `RTCStatsReport` for the
      // callers we care about (WebRTCStatsCollector.parse uses forEach).
      return new Map(entries) as unknown as RTCStatsReport;
    },
  };
}
