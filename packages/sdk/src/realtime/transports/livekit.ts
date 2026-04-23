/**
 * LiveKit transport for the realtime SDK.
 *
 * Control flow mirrors WebRTCConnection (same WS URL, same control messages
 * for prompt/set_image/init/session_id/generation_tick). The only differences
 * are in the media handshake:
 *
 *   Client → bouncer WS: { type: "livekit_join" }
 *   bouncer/inference   → { type: "livekit_room_info", livekit_url, token, room_name }
 *   Client → LiveKit SFU: Room.connect(url, token) + publishTrack(...)
 *
 * Public surface matches WebRTCConnection enough that WebRTCManager can swap
 * implementations behind a `transport` option.
 */

import mitt from "mitt";
import {
  ConnectionState as LKConnectionState,
  Room,
  RoomEvent,
  Track,
  TrackEvent,
  type LocalTrack,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RemoteParticipant,
} from "livekit-client";

import type { Logger } from "../../utils/logger";
import { buildUserAgent } from "../../utils/user-agent";
import type { DiagnosticEmitter } from "../diagnostics";
import type { StatsProvider } from "../webrtc-stats";
import type {
  ConnectionState,
  GenerationTickMessage,
  IncomingWebRTCMessage,
  OutgoingWebRTCMessage,
  PromptAckMessage,
  ServerMetricsMessage,
  SessionIdMessage,
  SetImageAckMessage,
} from "../types";

const AVATAR_SETUP_TIMEOUT_MS = 30_000;
const ROOM_INFO_TIMEOUT_MS = 15_000;

interface LiveKitCallbacks {
  onRemoteStream?: (stream: MediaStream) => void;
  onStateChange?: (state: ConnectionState) => void;
  onError?: (error: Error) => void;
  modelName?: string;
  initialImage?: string;
  initialPrompt?: { text: string; enhance?: boolean };
  logger?: Logger;
  onDiagnostic?: DiagnosticEmitter;
  /** Override livekit-client `publishTrack` simulcast option. Defaults to true. */
  publishSimulcast?: boolean;
  /**
   * Client-side uplink cap in kbps. Defaults to 2500 to match the
   * server-side publish cap (see inference_server/rt/livekit/conn.py).
   * Pass `null` explicitly to omit the cap entirely and let Chrome BWE
   * run uncapped.
   */
  publishMaxBitrateKbps?: number | null;
  /**
   * livekit-client `Room` options. Both default to `false` — matches the
   * current shipped behavior. Exposed primarily so the webrtc-bench tool
   * can sweep these without forking the SDK. Enabling either in production
   * changes quality/bandwidth trade-offs, so leave them off unless you
   * know what you're doing.
   */
  adaptiveStream?: boolean;
  dynacast?: boolean;
}

const DEFAULT_PUBLISH_MAX_BITRATE_KBPS = 3500;

type WsMessageEvents = {
  promptAck: PromptAckMessage;
  setImageAck: SetImageAckMessage;
  sessionId: SessionIdMessage;
  generationTick: GenerationTickMessage;
  serverMetrics: ServerMetricsMessage;
};

const noopDiagnostic: DiagnosticEmitter = () => {};

interface RoomInfoMessage {
  type: "livekit_room_info";
  livekit_url: string;
  token: string;
  room_name: string;
}

export class LiveKitConnection {
  private ws: WebSocket | null = null;
  private room: Room | null = null;
  private localStream: MediaStream | null = null;
  private connectionReject: ((error: Error) => void) | null = null;
  private logger: Logger;
  private emitDiagnostic: DiagnosticEmitter;
  private statsProvider: StatsProvider | null = null;
  state: ConnectionState = "disconnected";
  websocketMessagesEmitter = mitt<WsMessageEvents>();

  constructor(private callbacks: LiveKitCallbacks = {}) {
    this.logger = callbacks.logger ?? { debug() {}, info() {}, warn() {}, error() {} };
    this.emitDiagnostic = callbacks.onDiagnostic ?? noopDiagnostic;
  }

  getPeerConnection(): RTCPeerConnection | null {
    // No raw PC for the LiveKit transport — the SFU hides the PCs behind
    // a Room abstraction. Callers that need stats should use
    // getStatsProvider() instead; it aggregates per-track `getRTCStatsReport()`
    // results into an RTCStatsReport-shaped object.
    return null;
  }

  /**
   * Stats provider for the livekit transport. Aggregates
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

    // Append user agent exactly like the aiortc transport.
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
      const roomInfoStart = performance.now();
      await this.openControlWs(wsUrl, timeout);
      const roomInfo = await this.requestRoomInfo();
      this.emitDiagnostic("phaseTiming", {
        phase: "websocket",
        durationMs: performance.now() - roomInfoStart,
        success: true,
      });

      // Phase 2 — join the SFU room and publish local tracks.
      const roomStart = performance.now();
      await this.joinRoom(roomInfo);
      this.emitDiagnostic("phaseTiming", {
        phase: "webrtc-handshake",
        durationMs: performance.now() - roomStart,
        success: true,
      });

      // Phase 3 — optional: send initial prompt over control WS.
      if (this.callbacks.initialPrompt) {
        await this.sendInitialPrompt(this.callbacks.initialPrompt);
      }

      this.setState("connected");
    } catch (error) {
      this.cleanup();
      throw error;
    } finally {
      this.connectionReject = null;
    }
  }

  send(message: OutgoingWebRTCMessage): boolean {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
      return true;
    }
    this.logger.warn("Message dropped: WebSocket is not open");
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
      }, options?.timeout ?? AVATAR_SETUP_TIMEOUT_MS);

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
        this.logger.info("LiveKit control WS closed", { code: e.code, reason: e.reason });
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
          this.logger.error("LiveKit control WS message parse error", { error: String(error) });
        }
      };
    });
  }

  private async requestRoomInfo(): Promise<RoomInfoMessage> {
    this.send({ type: "livekit_join" } as unknown as OutgoingWebRTCMessage);
    return await new Promise<RoomInfoMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`livekit_room_info timeout (${ROOM_INFO_TIMEOUT_MS}ms)`));
      }, ROOM_INFO_TIMEOUT_MS);

      const handler = (msg: IncomingWebRTCMessage | RoomInfoMessage) => {
        if ((msg as RoomInfoMessage).type === "livekit_room_info") {
          cleanup();
          resolve(msg as RoomInfoMessage);
        } else if ((msg as { type: string }).type === "error") {
          cleanup();
          reject(new Error((msg as { error?: string }).error ?? "server error"));
        }
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.pendingRoomInfoResolvers = this.pendingRoomInfoResolvers.filter((h) => h !== handler);
      };
      this.pendingRoomInfoResolvers.push(handler);
    });
  }

  private pendingRoomInfoResolvers: Array<(msg: IncomingWebRTCMessage | RoomInfoMessage) => void> = [];

  private handleControlMessage(msg: IncomingWebRTCMessage | RoomInfoMessage): void {
    // First give pending livekit_room_info awaiters a chance.
    for (const resolver of [...this.pendingRoomInfoResolvers]) {
      resolver(msg);
    }

    // Then fan out control-plane acks to the shared emitter (same events
    // WebRTCConnection emits so RealTimeClient consumes both identically).
    const typed = msg as IncomingWebRTCMessage;
    switch (typed.type) {
      case "prompt_ack":
        this.websocketMessagesEmitter.emit("promptAck", typed);
        break;
      case "set_image_ack":
        this.websocketMessagesEmitter.emit("setImageAck", typed);
        break;
      case "session_id":
        this.websocketMessagesEmitter.emit("sessionId", typed);
        break;
      case "generation_tick":
        this.websocketMessagesEmitter.emit("generationTick", typed);
        break;
      case "server_metrics":
        // Opt-in server-side stats for the webrtc-bench tool.
        this.websocketMessagesEmitter.emit("serverMetrics", typed);
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Private — LiveKit room
  // -------------------------------------------------------------------------

  private async joinRoom(info: RoomInfoMessage): Promise<void> {
    this.room = new Room({
      adaptiveStream: this.callbacks.adaptiveStream ?? false,
      dynacast: this.callbacks.dynacast ?? false,
    });

    this.room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _pub: RemoteTrackPublication, _p: RemoteParticipant) => {
      if (track.kind === Track.Kind.Video || track.kind === Track.Kind.Audio) {
        // Compose a MediaStream for the SDK consumer. We attach the track
        // element so downstream TrackEvent.VideoPlaybackStarted fires and
        // the browser actually starts decoding — the element isn't kept.
        track.attach();
        const mediaStreamTrack = track.mediaStreamTrack;
        if (mediaStreamTrack) {
          const stream = new MediaStream([mediaStreamTrack]);
          this.callbacks.onRemoteStream?.(stream);
        }
        track.on(TrackEvent.VideoPlaybackStarted, () => {
          this.setState("generating");
        });
      }
    });

    this.room.on(RoomEvent.Connected, () => {
      this.logger.info("LiveKit room connected");
    });
    this.room.on(RoomEvent.Disconnected, (reason?: unknown) => {
      this.logger.info("LiveKit room disconnected", { reason: String(reason) });
      this.setState("disconnected");
    });

    await this.room.connect(info.livekit_url, info.token);

    // Wire up the stats provider now that the room has local+remote
    // participant objects available. Held by reference here so the SDK
    // client's identity-check in handleConnectionStateChange() sees a
    // stable provider for this room.
    this.statsProvider = createLiveKitStatsProvider(this.room);

    // Publish local tracks. Inference server expects a video track; audio is optional.
    if (this.localStream) {
      const publishSimulcast = this.callbacks.publishSimulcast ?? true;
      // Three-state resolution for the bitrate cap:
      //   undefined → apply the SDK default (2500 kbps)
      //   null      → explicit opt-out, no cap (Chrome BWE runs unclamped)
      //   number    → explicit kbps value
      const configuredBitrateKbps = this.callbacks.publishMaxBitrateKbps;
      const maxBitrate =
        configuredBitrateKbps === null
          ? undefined
          : (configuredBitrateKbps ?? DEFAULT_PUBLISH_MAX_BITRATE_KBPS) * 1000;
      this.logger.info("LiveKit client publish config", {
        simulcast: publishSimulcast,
        maxBitrate,
        adaptiveStream: this.callbacks.adaptiveStream ?? false,
        dynacast: this.callbacks.dynacast ?? false,
      });
      for (const track of this.localStream.getTracks()) {
        if (track.kind === "video") {
          await this.room.localParticipant.publishTrack(track, {
            simulcast: publishSimulcast,
            source: Track.Source.Camera,
            ...(maxBitrate != null
              ? { videoEncoding: { maxBitrate, maxFramerate: 30 } }
              : {}),
          });
        } else {
          await this.room.localParticipant.publishTrack(track);
        }
      }
    }
  }

  private async sendInitialPrompt(prompt: { text: string; enhance?: boolean }): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.websocketMessagesEmitter.off("promptAck", listener);
        reject(new Error("Prompt send timed out"));
      }, AVATAR_SETUP_TIMEOUT_MS);

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

      const message = {
        type: "prompt",
        prompt: prompt.text,
        enhance: prompt.enhance ?? false,
      } as unknown as OutgoingWebRTCMessage;

      if (!this.send(message)) {
        clearTimeout(timeoutId);
        this.websocketMessagesEmitter.off("promptAck", listener);
        reject(new Error("WebSocket is not open"));
      }
    });
  }

  private setState(state: ConnectionState): void {
    if (this.state !== state) {
      this.state = state;
      this.callbacks.onStateChange?.(state);
    }
  }
}

/**
 * Build a StatsProvider that aggregates `track.getRTCStatsReport()` across
 * every local and remote track in a livekit Room into a single
 * RTCStatsReport-shaped Map.
 *
 * Why this shape: `WebRTCStatsCollector.parse()` expects to call
 * `.forEach((stat) => { ... })` on the returned object and keys off each
 * entry's `type` (inbound-rtp, outbound-rtp, candidate-pair). The standard
 * `RTCStatsReport` is an iterable map-like — our aggregate mimics that by
 * returning a `Map<string, unknown>` (structurally compatible with the spec).
 *
 * Each livekit track's `getRTCStatsReport()` under the hood calls
 * `RTCRtpSender.getStats()` / `RTCRtpReceiver.getStats()`, which in all
 * current browsers returns the track's inbound-rtp/outbound-rtp plus the
 * associated candidate-pair and transport reports. Stitching them together
 * per-tick gives us a report that looks like an aiortc-style
 * `RTCPeerConnection.getStats()` for parsing purposes.
 *
 * Key collisions (candidate-pair ids repeat across publisher+subscriber
 * PCs) are namespaced with a monotonic suffix so `forEach` sees every
 * entry once. `parse()` only cares about the last `candidate-pair` where
 * `state == "succeeded"`, so duplicate candidate-pair entries are harmless.
 */
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

      // Inbound: every remote participant's tracks (what the server sends
      // back to us — the model output).
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
