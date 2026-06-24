import {
  type DisconnectReason,
  type RemoteParticipant,
  type RemoteTrack,
  Room,
  RoomEvent,
  Track,
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
    const connectSpan = this.config.observability?.startSpan("MediaChannel.connect");
    this.room ??= new Room(REALTIME_CONFIG.livekit.roomOptions);
    const room = this.room;

    room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _pub, participant: RemoteParticipant) => {
      if (!participant.identity.startsWith(REALTIME_CONFIG.livekit.inferenceServerIdentityPrefix)) return;
      if (track.kind !== Track.Kind.Video && track.kind !== Track.Kind.Audio) return;

      const mediaStreamTrack = track.mediaStreamTrack;
      if (mediaStreamTrack) {
        // Feed the rendered remote video to the glass-to-glass marker reader
        // (no-op unless g2g measurement is enabled).
        if (track.kind === Track.Kind.Video) {
          this.config.observability?.attachRemoteVideoTrack(mediaStreamTrack);
        }
        // Emit a fresh MediaStream whenever the track set changes. Consumers
        // assign this to an element's `srcObject`; mutating the existing stream
        // in place would not work because assigning the same MediaStream
        // reference is a no-op and a late-arriving audio track would never get
        // an output sink. A new object forces the element to re-read its tracks,
        // so a single <video> element plays both video and audio.
        const tracks = this.remoteStream?.getTracks() ?? [];
        if (!tracks.includes(mediaStreamTrack)) {
          tracks.push(mediaStreamTrack);
        }
        this.remoteStream = new MediaStream(tracks);
        this.events.emit("remoteStream", this.remoteStream);
      }
    });

    room.on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
      this.logger.warn("livekit: room disconnected", { reason });
      this.events.emit("disconnected", { reason });
    });

    this.config.observability?.startPhase("webrtc-handshake");
    const roomConnectSpan = this.config.observability?.startSpan("Room.connect");
    try {
      await room.connect(opts.url, opts.token);
      this.config.observability?.endSpan(roomConnectSpan);
      this.config.observability?.endPhase("webrtc-handshake", { success: true });
      const statsSpan = this.config.observability?.startSpan("RealtimeObservability.setLiveKitRoom");
      this.config.observability?.setLiveKitRoom(room);
      this.config.observability?.endSpan(statsSpan);
      this.config.observability?.endSpan(connectSpan);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.config.observability?.endSpan(roomConnectSpan, { success: false, error: message });
      this.config.observability?.endPhase("webrtc-handshake", { success: false, error: message });
      this.config.observability?.endSpan(connectSpan, { success: false, error: message });
      throw error;
    }
  }

  async publishLocalTracks(): Promise<void> {
    if (!this.config.localStream) return;
    const span = this.config.observability?.startSpan("MediaChannel.publishLocalTracks");
    this.config.observability?.startPhase("publish-local-track");
    try {
      await this.publishTracks(this.config.localStream);
      this.config.observability?.endPhase("publish-local-track", { success: true });
      this.config.observability?.endSpan(span);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.config.observability?.endPhase("publish-local-track", { success: false, error: message });
      this.config.observability?.endSpan(span, { success: false, error: message });
      throw error;
    }
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
    const span = this.config.observability?.startSpan("MediaChannel.publishTracks");
    try {
      for (const track of stream.getTracks()) {
        const publishTrackSpan = this.config.observability?.startSpan(
          "LocalParticipant.publishTrack",
          `${track.kind}:${track.id}`,
        );
        if (track.kind === "video") {
          const optionsSpan = this.config.observability?.startSpan("getDefaultVideoPublishOptions");
          const options = getDefaultVideoPublishOptions(this.config.videoCodec);
          this.config.observability?.endSpan(optionsSpan);
          await this.room.localParticipant.publishTrack(track, options);
        } else {
          await this.room.localParticipant.publishTrack(track);
        }
        this.config.observability?.endSpan(publishTrackSpan);
      }
      this.config.observability?.endSpan(span);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.config.observability?.endSpan(span, { success: false, error: message });
      throw error;
    }
  }
}
