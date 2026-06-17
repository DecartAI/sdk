import {
  type DisconnectReason,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteVideoTrack,
  Room,
  RoomEvent,
  type RoomOptions,
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
  /**
   * The subscribed remote video track (LiveKit wrapper, not the raw
   * MediaStreamTrack). Carries `packetTrailerExtractor` when a
   * packet-trailer worker is configured, letting consumers read per-frame
   * `user_timestamp` for end-to-end latency.
   */
  remoteVideoTrack: RemoteVideoTrack;
  disconnected: { reason?: DisconnectReason };
};

export interface MediaChannelConfig {
  observability?: RealtimeObservability;
  localStream: MediaStream | null;
  logger?: Logger;
  videoCodec?: VideoCodec;
  /**
   * Dedicated LiveKit packet-trailer worker (from
   * `livekit-client/packet-trailer-worker`). When set, the Room is created
   * with this worker, the local video publish opts into per-frame
   * `user_timestamp` stamping, and `RemoteVideoTrack.packetTrailerExtractor`
   * becomes available on the subscribed track. The worker must be provided by
   * the consumer because bundling a Web Worker is build-tool specific.
   */
  packetTrailerWorker?: Worker;
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
    const roomOptions: RoomOptions = { ...REALTIME_CONFIG.livekit.roomOptions };
    if (this.config.packetTrailerWorker) {
      roomOptions.packetTrailer = { worker: this.config.packetTrailerWorker };
    }
    this.room ??= new Room(roomOptions);
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
          // Surface the LiveKit track wrapper too — its `packetTrailerExtractor`
          // (present when a packet-trailer worker is configured) is how
          // consumers read per-frame `user_timestamp` for E2E latency.
          this.events.emit("remoteVideoTrack", track as RemoteVideoTrack);
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
        const publishOptions = getDefaultVideoPublishOptions(this.config.videoCodec);
        if (this.config.packetTrailerWorker) {
          // Auto-fill `user_timestamp = Date.now() * 1000` on every encoded
          // frame's packet trailer; the server echoes it onto the output frame.
          publishOptions.packetTrailer = { timestamp: true };
        }
        await this.room.localParticipant.publishTrack(track, publishOptions);
      } else {
        await this.room.localParticipant.publishTrack(track);
      }
    }
  }
}
