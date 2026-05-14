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
import { REALTIME_CONFIG } from "./config-realtime";
import type { RealtimeObservability } from "./observability/realtime-observability";

export function getDefaultVideoPublishOptions(): TrackPublishOptions {
  const videoEncoding = {
    maxBitrate: REALTIME_CONFIG.livekit.defaultMaxVideoBitrateBps,
    maxFramerate: REALTIME_CONFIG.livekit.defaultPublishFps,
  };

  return {
    source: Track.Source.Camera,
    videoCodec: REALTIME_CONFIG.livekit.defaultVideoCodec,
    simulcast: true,
    videoEncoding,
  };
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

    await room.connect(opts.url, opts.token);
    if (this.config.localStream) {
      await this.publishLocalTracks(this.config.localStream);
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
