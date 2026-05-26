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

import { createConsoleLogger, type Logger } from "../utils/logger";
import { REALTIME_CONFIG } from "./config-realtime";
import type { RealtimeObservability } from "./observability/realtime-observability";

export type VideoCodec = "h264" | "vp8" | "vp9" | "av1";

export function getDefaultVideoPublishOptions(videoCodec?: VideoCodec): TrackPublishOptions {
  const resolvedCodec = videoCodec ?? REALTIME_CONFIG.livekit.defaultVideoCodec;
  const maxBitrate =
    resolvedCodec === "vp9"
      ? REALTIME_CONFIG.livekit.vp9MaxVideoBitrateBps
      : REALTIME_CONFIG.livekit.defaultMaxVideoBitrateBps;

  return {
    source: Track.Source.Camera,
    videoCodec: resolvedCodec,
    simulcast: resolvedCodec !== "vp9",
    videoEncoding: {
      maxBitrate,
      maxFramerate: REALTIME_CONFIG.livekit.defaultPublishFps,
    },
  };
}

export type MediaChannelEvents = {
  remoteStream: MediaStream;
  firstFrame: undefined;
  disconnected: { reason?: DisconnectReason };
};

export interface MediaChannelConfig {
  observability?: RealtimeObservability;
  localStream: MediaStream | null;
  logger?: Logger;
  videoCodec?: VideoCodec;
}

export type MediaConnectOptions = {
  url: string;
  token: string;
};

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

  async connect(opts: MediaConnectOptions): Promise<void> {
    this.room ??= new Room(REALTIME_CONFIG.livekit.roomOptions);
    const room = this.room;

    room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _pub, participant: RemoteParticipant) => {
      if (!participant.identity.startsWith(REALTIME_CONFIG.livekit.inferenceServerIdentityPrefix)) return;
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

    this.config.observability?.startPhase("webrtc-handshake");
    await room.connect(opts.url, opts.token);
    this.config.observability?.endPhase("webrtc-handshake", { success: true });
    this.config.observability?.setLiveKitRoom(room);
  }

  async publishLocalTracks(): Promise<void> {
    if (!this.config.localStream) return;
    this.config.observability?.startPhase("publish-local-track");
    await this.publishTracks(this.config.localStream);
    this.config.observability?.endPhase("publish-local-track", { success: true });
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

  private async publishTracks(stream: MediaStream): Promise<void> {
    if (!this.room) return;
    for (const track of stream.getTracks()) {
      if (track.kind === "video") {
        await this.room.localParticipant.publishTrack(track, getDefaultVideoPublishOptions(this.config.videoCodec));
      } else {
        await this.room.localParticipant.publishTrack(track);
      }
    }
  }
}
