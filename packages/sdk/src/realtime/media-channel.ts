import {
  type RemoteParticipant,
  type RemoteTrack,
  Room,
  type RoomConnectOptions,
  RoomEvent,
  type RoomOptions,
  Track,
  TrackEvent,
  type TrackPublishOptions,
} from "livekit-client";
import mitt, { type Emitter } from "mitt";

import type { ModelDefinition } from "../shared/model";
import type { RealtimeObservability } from "./observability/realtime-observability";

type PublishModel = Pick<ModelDefinition, "fps">;

const INFERENCE_SERVER_IDENTITY_PREFIX = "inference-server-";

const DEFAULT_VIDEO_CODEC = "h264" as const;
const DEFAULT_MAX_VIDEO_BITRATE_BPS = 3_000_000;
const DEFAULT_PUBLISH_FPS = 20;

export const LIVEKIT_ROOM_OPTIONS: RoomOptions = {
  adaptiveStream: false,
  dynacast: false,
  singlePeerConnection: true,
  publishDefaults: {
    simulcast: false,
    degradationPreference: "maintain-framerate",
  },
};

export const LIVEKIT_CONNECT_OPTIONS: RoomConnectOptions = {
  peerConnectionTimeout: 8_000,
  websocketTimeout: 8_000,
  maxRetries: 1,
  rtcConfig: {
    iceCandidatePoolSize: 4,
    bundlePolicy: "max-bundle",
    rtcpMuxPolicy: "require",
  },
};

export function getDefaultVideoPublishOptions(model: PublishModel): TrackPublishOptions {
  const videoEncoding = {
    maxBitrate: DEFAULT_MAX_VIDEO_BITRATE_BPS,
    maxFramerate: model.fps,
  };

  return { source: Track.Source.Camera, videoCodec: DEFAULT_VIDEO_CODEC, videoEncoding };
}

export type MediaChannelEvents = {
  remoteStream: MediaStream;
  firstFrame: void;
  disconnected: void;
};

export interface MediaChannelConfig {
  observability?: RealtimeObservability;
  localStream: MediaStream | null;
  model?: PublishModel;
}

export class MediaChannel {
  private room: Room | null = null;
  private remoteStream: MediaStream | null = null;
  private events: Emitter<MediaChannelEvents> = mitt();

  constructor(private readonly config: MediaChannelConfig) {}

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

    room.on(RoomEvent.Disconnected, () => {
      this.events.emit("disconnected");
    });

    await room.connect(opts.url, opts.token, LIVEKIT_CONNECT_OPTIONS);
    this.config.observability?.setLiveKitRoom(room);

    if (this.config.localStream) {
      await this.publishLocalTracks(this.config.localStream);
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

  private async publishLocalTracks(stream: MediaStream): Promise<void> {
    if (!this.room) return;
    const publishModel = this.config.model ?? { fps: DEFAULT_PUBLISH_FPS };
    for (const track of stream.getTracks()) {
      if (track.kind === "video") {
        await this.room.localParticipant.publishTrack(track, getDefaultVideoPublishOptions(publishModel));
      } else {
        await this.room.localParticipant.publishTrack(track);
      }
    }
  }
}
