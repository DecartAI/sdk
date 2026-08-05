import type {
  DisconnectReason,
  RemoteParticipant,
  RemoteTrack,
  RemoteVideoTrack,
  Room,
  TrackPublishOptions,
} from "livekit-client";
import mitt, { type Emitter } from "mitt";

import { createConsoleLogger, type Logger } from "../utils/logger";
import { REALTIME_CONFIG } from "./config-realtime";
import { loadLiveKitClient } from "./livekit";
import type { RealtimeObservability } from "./observability/realtime-observability";

export type VideoCodec = "h264" | "vp8" | "vp9" | "av1";

export function getDefaultVideoPublishOptions(
  source: TrackPublishOptions["source"],
  videoCodec?: VideoCodec,
  frameMetadata = false,
): TrackPublishOptions {
  const resolvedCodec = videoCodec ?? REALTIME_CONFIG.livekit.defaultVideoCodec;
  const maxBitrate =
    resolvedCodec === "vp9"
      ? REALTIME_CONFIG.livekit.vp9MaxVideoBitrateBps
      : REALTIME_CONFIG.livekit.defaultMaxVideoBitrateBps;

  return {
    source,
    videoCodec: resolvedCodec,
    simulcast: resolvedCodec !== "vp9",
    videoEncoding: {
      maxBitrate,
      maxFramerate: REALTIME_CONFIG.livekit.defaultPublishFps,
    },
    ...(frameMetadata ? { frameMetadata: { timestamp: true } } : {}),
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
  createFrameMetadataWorker?: () => Worker;
}

export type MediaConnectOptions = {
  url: string;
  token: string;
};

export interface MediaChannel {
  readonly localStream: MediaStream | null;
  on<E extends keyof MediaChannelEvents>(event: E, handler: (data: MediaChannelEvents[E]) => void): void;
  off<E extends keyof MediaChannelEvents>(event: E, handler: (data: MediaChannelEvents[E]) => void): void;
  connect(opts: MediaConnectOptions): Promise<void>;
  publishLocalTracks(): Promise<void>;
  replaceVideoTrack(track: MediaStreamTrack): Promise<void>;
  disconnect(): void;
}

export type MediaChannelFactory = (config: MediaChannelConfig) => MediaChannel;

export class LiveKitMediaChannel implements MediaChannel {
  private room: Room | null = null;
  private cameraTrackSource: TrackPublishOptions["source"] | null = null;
  private remoteStream: MediaStream | null = null;
  private frameMetadataEnabled = false;
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
    const { Room: LiveKitRoom, RoomEvent, Track } = await loadLiveKitClient();
    this.cameraTrackSource = Track.Source.Camera;
    if (!this.room) {
      let worker: Worker | undefined;
      if (this.config.createFrameMetadataWorker) {
        try {
          worker = this.config.createFrameMetadataWorker();
        } catch (error) {
          this.logger.warn("Failed to create LiveKit frame-metadata worker; continuing without latency metrics", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      this.frameMetadataEnabled = worker !== undefined;
      try {
        this.room = new LiveKitRoom({
          ...REALTIME_CONFIG.livekit.roomOptions,
          ...(worker ? { frameMetadata: { worker } } : {}),
        });
      } catch (error) {
        worker?.terminate();
        this.frameMetadataEnabled = false;
        throw error;
      }
    }
    const room = this.room;

    room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _pub, participant: RemoteParticipant) => {
      if (!participant.identity.startsWith(REALTIME_CONFIG.livekit.inferenceServerIdentityPrefix)) return;
      if (track.kind !== "video" && track.kind !== "audio") return;

      const mediaStreamTrack = track.mediaStreamTrack;
      if (mediaStreamTrack) {
        // Feed the LiveKit track to the frame-metadata render reader (a no-op
        // unless opt-in glass-to-glass measurement is enabled).
        if (track.kind === "video") {
          this.config.observability?.attachRemoteVideoTrack(track as RemoteVideoTrack);
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

  async replaceVideoTrack(track: MediaStreamTrack): Promise<void> {
    const room = this.room;
    if (!room) throw new Error("Cannot replace video track: media channel is not connected");
    const publication = [...room.localParticipant.videoTrackPublications.values()][0];
    const videoTrack = publication?.videoTrack;
    if (!videoTrack) throw new Error("Cannot replace video track: no published video track");
    await videoTrack.replaceTrack(track);
  }

  disconnect(): void {
    const room = this.room;
    this.room = null;
    this.cameraTrackSource = null;
    this.remoteStream = null;
    this.frameMetadataEnabled = false;
    this.config.observability?.setLiveKitRoom(null);
    if (room) {
      room.disconnect().catch(() => {});
    }
  }

  private async publishTracks(stream: MediaStream): Promise<void> {
    if (!this.room) return;
    for (const track of stream.getTracks()) {
      if (track.kind === "video") {
        if (!this.cameraTrackSource) throw new Error("Cannot publish video track: media channel is not connected");
        await this.room.localParticipant.publishTrack(
          track,
          getDefaultVideoPublishOptions(this.cameraTrackSource, this.config.videoCodec, this.frameMetadataEnabled),
        );
      } else {
        await this.room.localParticipant.publishTrack(track);
      }
    }
  }
}

export const createLiveKitMediaChannel: MediaChannelFactory = (config) => new LiveKitMediaChannel(config);
