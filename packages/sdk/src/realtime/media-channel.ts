import {
  type DisconnectReason,
  type RemoteParticipant,
  type RemoteTrack,
  Room,
  RoomEvent,
  Track,
  TrackEvent,
  type TrackPublishOptions,
} from "livekit-client";
import mitt, { type Emitter } from "mitt";

import { type Logger, createConsoleLogger } from "../utils/logger";
import type { RealtimeObservability } from "./observability/realtime-observability";

const INFERENCE_SERVER_IDENTITY_PREFIX = "inference-server-";

const DEFAULT_VIDEO_CODEC = "h264" as const;
const DEFAULT_MAX_VIDEO_BITRATE_BPS = 3_500_000;
const DEFAULT_PUBLISH_FPS = 30;

export const LIVEKIT_ROOM_OPTIONS = {
  adaptiveStream: false,
  dynacast: false,
} as const;

export function getDefaultVideoPublishOptions(): TrackPublishOptions {
  const videoEncoding = {
    maxBitrate: DEFAULT_MAX_VIDEO_BITRATE_BPS,
    maxFramerate: DEFAULT_PUBLISH_FPS,
  };

  return { source: Track.Source.Camera, videoCodec: DEFAULT_VIDEO_CODEC, simulcast: true, videoEncoding };
}

export type MediaChannelEvents = {
  remoteStream: MediaStream;
  firstFrame: void;
  disconnected: { reason?: DisconnectReason };
};

export interface MediaChannelConfig {
  observability?: RealtimeObservability;
  localStream: MediaStream | null;
  logger?: Logger;
}

export class MediaChannel {
  private room: Room | null = null;
  private remoteStream: MediaStream | null = null;
  private events: Emitter<MediaChannelEvents> = mitt();
  private readonly logger: Logger;

  constructor(private readonly config: MediaChannelConfig) {
    this.logger = config.logger ?? createConsoleLogger("warn");
  }

  get localStream(): MediaStream | null {
    return this.config.localStream;
  }

  on<E extends keyof MediaChannelEvents>(event: E, handler: (data: MediaChannelEvents[E]) => void): void {
    this.events.on(event, handler);
  }

  off<E extends keyof MediaChannelEvents>(event: E, handler: (data: MediaChannelEvents[E]) => void): void {
    this.events.off(event, handler);
  }

  prepare(url: string, token: string): void {
    this.room ??= new Room(LIVEKIT_ROOM_OPTIONS);
    this.room.prepareConnection(url, token).catch(() => {});
  }

  async connect(opts: { url: string; token: string }): Promise<void> {
    this.room ??= new Room(LIVEKIT_ROOM_OPTIONS);
    const room = this.room;

    room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _pub, participant: RemoteParticipant) => {
      if (!participant.identity.startsWith(INFERENCE_SERVER_IDENTITY_PREFIX)) return;
      if (track.kind !== Track.Kind.Video && track.kind !== Track.Kind.Audio) return;

      track.attach();
      const mediaStreamTrack = track.mediaStreamTrack;
      if (mediaStreamTrack) {
        this.remoteStream ??= new MediaStream();
        if (!this.remoteStream.getTracks().includes(mediaStreamTrack)) {
          this.remoteStream.addTrack(mediaStreamTrack);
        }
        this.events.emit("remoteStream", this.remoteStream);
      }
      track.on(TrackEvent.VideoPlaybackStarted, () => {
        this.events.emit("firstFrame");
      });
    });

    room.on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
      this.logger.warn("livekit: room disconnected", { reason });
      this.events.emit("disconnected", { reason });
    });

    const handshakeStart = Date.now();
    try {
      await room.connect(opts.url, opts.token);
      if (this.config.localStream) {
        await this.publishLocalTracks(this.config.localStream);
      }
      this.config.observability?.diagnostic("phaseTiming", {
        phase: "webrtc-handshake",
        durationMs: Date.now() - handshakeStart,
        success: true,
      });
      this.logger.debug("livekit: room connected", { durationMs: Date.now() - handshakeStart });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.config.observability?.diagnostic("phaseTiming", {
        phase: "webrtc-handshake",
        durationMs: Date.now() - handshakeStart,
        success: false,
        error: message,
      });
      this.logger.error("livekit: room connect failed", {
        durationMs: Date.now() - handshakeStart,
        error: message,
      });
      throw error;
    }
    this.config.observability?.setLiveKitRoom(room);
  }

  disconnect(): void {
    const room = this.room;
    this.room = null;
    this.remoteStream = null;
    this.config.observability?.setLiveKitRoom(null);
    if (room) {
      room.disconnect().catch(() => {});
    }
  }

  private async publishLocalTracks(stream: MediaStream): Promise<void> {
    if (!this.room) return;
    for (const track of stream.getTracks()) {
      if (track.kind === "video") {
        await this.room.localParticipant.publishTrack(track, getDefaultVideoPublishOptions());
      } else {
        await this.room.localParticipant.publishTrack(track);
      }
    }
  }
}
