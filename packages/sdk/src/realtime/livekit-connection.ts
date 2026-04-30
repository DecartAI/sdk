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
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
  Room,
  RoomEvent,
  Track,
  TrackEvent,
} from "livekit-client";
import mitt from "mitt";

import type { Logger } from "../utils/logger";
import { buildUserAgent } from "../utils/user-agent";
import type { DiagnosticEmitter } from "./diagnostics";
import type {
  ConnectionState,
  GenerationTickMessage,
  IncomingRealtimeMessage,
  LiveKitRoomInfoMessage,
  OutgoingRealtimeMessage,
  PromptAckMessage,
  QueuePositionMessage,
  SessionIdMessage,
  SetImageAckMessage,
  StatusMessage,
} from "./types";
import type { StatsProvider } from "./webrtc-stats";

const SETUP_TIMEOUT_MS = 30_000;
const ROOM_INFO_TIMEOUT_MS = 15_000;
const DEFAULT_VIDEO_CODEC = "h264";
const DEFAULT_MAX_VIDEO_BITRATE_BPS = 2_500_000;
const DEFAULT_MAX_VIDEO_BITRATE_KBPS = DEFAULT_MAX_VIDEO_BITRATE_BPS / 1000;

function sanitizeUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.searchParams.has("api_key")) u.searchParams.set("api_key", "***");
    return u.toString();
  } catch {
    return url.replace(/api_key=[^&]*/g, "api_key=***");
  }
}

interface LiveKitCallbacks {
  onRemoteStream?: (stream: MediaStream) => void;
  onStateChange?: (state: ConnectionState) => void;
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
  generationTick: GenerationTickMessage;
  status: StatusMessage;
  queuePosition: QueuePositionMessage;
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
  private wsOpenedAt: number | null = null;
  state: ConnectionState = "disconnected";
  websocketMessagesEmitter = mitt<WsMessageEvents>();

  constructor(private callbacks: LiveKitCallbacks = {}) {
    this.logger = callbacks.logger ?? { debug() {}, info() {}, warn() {}, error() {} };
    this.emitDiagnostic = callbacks.onDiagnostic ?? noopDiagnostic;
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

    this.logger.debug("LiveKit connection.connect()", {
      url: sanitizeUrl(wsUrl),
      timeoutMs: timeout,
      mode: localStream ? "publish" : "subscribe",
      tracks: localStream?.getTracks?.().map((t) => t.kind) ?? [],
    });

    let rejectConnect!: (error: Error) => void;
    const connectAbort = new Promise<never>((_, reject) => {
      rejectConnect = reject;
    });
    connectAbort.catch(() => {});
    this.connectionReject = (error) => rejectConnect(error);

    try {
      // Phase 1 — control WS + livekit_join/livekit_room_info handshake.
      const roomInfoStart = performance.now();
      this.logger.debug("LiveKit connection phase started", { phase: "websocket" });
      await Promise.race([this.openControlWs(wsUrl, timeout), connectAbort]);
      const roomInfo = await Promise.race([this.requestRoomInfo(), connectAbort]);
      this.logger.debug("LiveKit connection phase completed", {
        phase: "websocket",
        durationMs: performance.now() - roomInfoStart,
      });
      this.emitDiagnostic("phaseTiming", {
        phase: "websocket",
        durationMs: performance.now() - roomInfoStart,
        success: true,
      });

      // Phase 2 — join the SFU room and publish local tracks.
      const roomStart = performance.now();
      this.logger.debug("LiveKit connection phase started", { phase: "webrtc-handshake" });
      await Promise.race([this.joinRoom(roomInfo), connectAbort]);
      this.logger.debug("LiveKit connection phase completed", {
        phase: "webrtc-handshake",
        durationMs: performance.now() - roomStart,
      });
      this.emitDiagnostic("phaseTiming", {
        phase: "webrtc-handshake",
        durationMs: performance.now() - roomStart,
        success: true,
      });

      // Phase 3 — optional startup conditioning over the control WS.
      if (this.callbacks.initialImage) {
        const imageStart = performance.now();
        this.logger.debug("LiveKit connection phase started", { phase: "initial-image" });
        await Promise.race([
          this.setImageBase64(this.callbacks.initialImage, {
            prompt: this.callbacks.initialPrompt?.text,
            enhance: this.callbacks.initialPrompt?.enhance,
          }),
          connectAbort,
        ]);
        this.logger.debug("LiveKit connection phase completed", {
          phase: "initial-image",
          durationMs: performance.now() - imageStart,
        });
        this.emitDiagnostic("phaseTiming", {
          phase: "initial-image",
          durationMs: performance.now() - imageStart,
          success: true,
        });
      } else if (this.callbacks.initialPrompt) {
        const promptStart = performance.now();
        this.logger.debug("LiveKit connection phase started", { phase: "initial-prompt" });
        await Promise.race([this.sendInitialPrompt(this.callbacks.initialPrompt), connectAbort]);
        this.logger.debug("LiveKit connection phase completed", {
          phase: "initial-prompt",
          durationMs: performance.now() - promptStart,
        });
        this.emitDiagnostic("phaseTiming", {
          phase: "initial-prompt",
          durationMs: performance.now() - promptStart,
          success: true,
        });
      } else if (localStream) {
        const passthroughStart = performance.now();
        this.logger.debug("LiveKit connection phase started", { phase: "initial-prompt", mode: "passthrough" });
        await Promise.race([this.setImageBase64(null, { prompt: null }), connectAbort]);
        this.logger.debug("LiveKit connection phase completed", {
          phase: "initial-prompt",
          mode: "passthrough",
          durationMs: performance.now() - passthroughStart,
        });
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
    this.logger.warn("Message dropped: WebSocket is not open", {
      messageType: message.type,
      readyState: this.ws?.readyState ?? null,
    });
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
      const openStart = performance.now();
      const timer = setTimeout(() => reject(new Error("WebSocket timeout")), timeout);
      this.logger.debug("Opening LiveKit control WebSocket", {
        url: sanitizeUrl(wsUrl),
        timeoutMs: timeout,
      });
      this.ws = new WebSocket(wsUrl);
      this.wsOpenedAt = openStart;
      this.ws.onopen = () => {
        clearTimeout(timer);
        this.logger.debug("LiveKit control WebSocket opened", {
          handshakeMs: Math.round(performance.now() - openStart),
        });
        resolve();
      };
      this.ws.onclose = (e) => {
        this.logger.info("LiveKit control WS closed", {
          code: e.code,
          reason: e.reason || "(none)",
          wasClean: e.wasClean,
          uptimeMs: this.wsOpenedAt ? Math.round(performance.now() - this.wsOpenedAt) : null,
        });
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
    const askedAt = performance.now();
    this.logger.debug("Requesting LiveKit room info", { timeoutMs: ROOM_INFO_TIMEOUT_MS });
    this.send({ type: "livekit_join" });
    return await new Promise<LiveKitRoomInfoMessage>((resolve, reject) => {
      // Sliding window: each `status` / `queue_position` update resets the
      // timer, so the deadline measures *server silence* — not total queue
      // wait. A client sitting in queue with steady updates can wait
      // indefinitely without timing out.
      let timer = setTimeout(onTimeout, ROOM_INFO_TIMEOUT_MS);
      function onTimeout() {
        cleanup();
        reject(new Error(`livekit_room_info timeout (${ROOM_INFO_TIMEOUT_MS}ms)`));
      }
      const resetTimer = () => {
        clearTimeout(timer);
        timer = setTimeout(onTimeout, ROOM_INFO_TIMEOUT_MS);
      };

      const handler = (msg: IncomingRealtimeMessage) => {
        if (msg.type === "livekit_room_info") {
          cleanup();
          this.logger.debug("Received LiveKit room info", {
            roomName: msg.room_name,
            sfuUrl: msg.livekit_url,
            tokenBytes: msg.token.length,
            waitMs: Math.round(performance.now() - askedAt),
          });
          resolve(msg);
        } else if (msg.type === "error") {
          cleanup();
          reject(new Error(msg.error));
        } else if (msg.type === "status" || msg.type === "queue_position") {
          resetTimer();
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
      case "generation_tick":
        this.websocketMessagesEmitter.emit("generationTick", msg);
        break;
      case "status":
        this.websocketMessagesEmitter.emit("status", msg);
        break;
      case "queue_position":
        this.websocketMessagesEmitter.emit("queuePosition", msg);
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
    this.logger.debug("Joining LiveKit room", {
      roomName: info.room_name,
      sfuUrl: info.livekit_url,
      adaptiveStream: false,
      dynacast: false,
    });
    this.room = new Room({
      adaptiveStream: false,
      dynacast: false,
    });

    this.room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, pub: RemoteTrackPublication, p: RemoteParticipant) => {
      if (track.kind === Track.Kind.Video || track.kind === Track.Kind.Audio) {
        track.attach();
        const mediaStreamTrack = track.mediaStreamTrack;
        if (mediaStreamTrack) {
          const settings = mediaStreamTrack.getSettings?.() ?? {};
          this.logger.debug("LiveKit remote track subscribed", {
            kind: track.kind,
            source: track.source,
            trackSid: track.sid ?? null,
            participant: p.identity,
            mimeType: pub.mimeType ?? null,
            width: settings.width ?? null,
            height: settings.height ?? null,
            frameRate: settings.frameRate ?? null,
          });
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

    this.room.on(RoomEvent.Connected, () => {
      this.logger.info("LiveKit room connected", {
        roomName: this.room?.name ?? null,
        participantIdentity: this.room?.localParticipant?.identity ?? null,
        participantSid: this.room?.localParticipant?.sid ?? null,
        remoteParticipants: this.room?.numParticipants ?? null,
      });
    });
    this.room.on(RoomEvent.Disconnected, (reason?: unknown) => {
      this.logger.info("LiveKit room disconnected", {
        roomName: this.room?.name ?? null,
        reason: String(reason),
      });
      this.setState("disconnected");
    });

    const roomConnectStart = performance.now();
    await this.room.connect(info.livekit_url, info.token);
    this.logger.debug("LiveKit room connect resolved", {
      roomName: info.room_name,
      sfuUrl: info.livekit_url,
      participantSid: this.room?.localParticipant?.sid ?? null,
      durationMs: Math.round(performance.now() - roomConnectStart),
    });

    // Wire up the stats provider now that the room has local+remote
    // participant objects available. Held by reference here so the SDK
    // client's identity-check in handleConnectionStateChange() sees a
    // stable provider for this room.
    this.statsProvider = createLiveKitStatsProvider(this.room);

    if (this.localStream) {
      await this.publishLocalTracks(this.localStream);
    }
  }

  private async publishLocalTracks(stream: MediaStream): Promise<void> {
    if (!this.room) return;
    this.logger.info("LiveKit client publish config", {
      codec: DEFAULT_VIDEO_CODEC,
      maxBitrateKbps: DEFAULT_MAX_VIDEO_BITRATE_KBPS,
      trackCount: stream.getTracks().length,
    });
    for (const track of stream.getTracks()) {
      const settings = track.getSettings?.() ?? {};
      this.logger.debug("Publishing local track to LiveKit", {
        kind: track.kind,
        label: track.label || null,
        width: settings.width ?? null,
        height: settings.height ?? null,
        frameRate: settings.frameRate ?? null,
        deviceId: settings.deviceId ?? null,
      });
      const publishStart = performance.now();
      if (track.kind === "video") {
        const publication = await this.room.localParticipant.publishTrack(track, {
          source: Track.Source.Camera,
          videoCodec: DEFAULT_VIDEO_CODEC,
          videoEncoding: { maxBitrate: DEFAULT_MAX_VIDEO_BITRATE_BPS },
        });
        this.logger.debug("LiveKit local video track published", {
          trackSid: publication.trackSid ?? null,
          mimeType: publication.mimeType ?? null,
          requestedCodec: DEFAULT_VIDEO_CODEC,
          maxBitrateKbps: DEFAULT_MAX_VIDEO_BITRATE_KBPS,
          durationMs: Math.round(performance.now() - publishStart),
        });
      } else {
        const publication = await this.room.localParticipant.publishTrack(track);
        this.logger.debug("LiveKit local track published", {
          kind: track.kind,
          trackSid: publication.trackSid ?? null,
          mimeType: publication.mimeType ?? null,
          durationMs: Math.round(performance.now() - publishStart),
        });
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

  private setState(state: ConnectionState): void {
    if (this.state !== state) {
      this.state = state;
      this.callbacks.onStateChange?.(state);
    }
  }
}

/**
 * Build a StatsProvider that aggregates `track.getRTCStatsReport()` across
 * every local and remote track in a LiveKit Room into a single
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
 * per-tick gives us a report compatible with the SDK's stats parser.
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
