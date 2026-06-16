import {
  type DisconnectReason,
  LocalVideoTrack,
  type LocalTrackPublication,
  type RemoteParticipant,
  type RemoteTrack,
  RemoteVideoTrack,
  Room,
  RoomEvent,
  type RoomOptions,
  Track,
  type TrackPublishOptions,
  type VideoReceiverStats,
  type VideoSenderStats,
} from "livekit-client";
import mitt, { type Emitter } from "mitt";

import { createConsoleLogger, type Logger } from "../utils/logger";
import { REALTIME_CONFIG } from "./config-realtime";
import type { RealtimeObservability } from "./observability/realtime-observability";

export type VideoCodec = "h264" | "vp8" | "vp9" | "av1";

export interface RealtimeVideoSenderStats extends VideoSenderStats {
  qpSum?: number;
  framesEncoded?: number;
  totalEncodeTime?: number;
  keyFramesEncoded?: number;
  codecMimeType?: string;
}

export interface RealtimeVideoReceiverStats extends VideoReceiverStats {
  qpSum?: number;
  freezeCount?: number;
  totalFreezesDuration?: number;
  pauseCount?: number;
  totalPausesDuration?: number;
  keyFramesDecoded?: number;
  framesPerSecond?: number;
  codecMimeType?: string;
}

export interface RealtimeVideoStats {
  sender: RealtimeVideoSenderStats[];
  receiver: RealtimeVideoReceiverStats[];
}

type RawOutboundRtp = {
  type?: string;
  kind?: string;
  rid?: string;
  ssrc?: number;
  qpSum?: number;
  framesEncoded?: number;
  totalEncodeTime?: number;
  keyFramesEncoded?: number;
  codecId?: string;
};

type RawInboundRtp = {
  type?: string;
  kind?: string;
  qpSum?: number;
  framesDropped?: number;
  freezeCount?: number;
  totalFreezesDuration?: number;
  pauseCount?: number;
  totalPausesDuration?: number;
  keyFramesDecoded?: number;
  framesPerSecond?: number;
  codecId?: string;
};

type RawCodec = { type?: string; id?: string; mimeType?: string };

function shortCodecName(mimeType: string | undefined): string | undefined {
  if (!mimeType) return undefined;
  const slash = mimeType.indexOf("/");
  return slash >= 0 ? mimeType.slice(slash + 1).toUpperCase() : mimeType.toUpperCase();
}

function collectCodecMimeMap(report: RTCStatsReport | null): Map<string, string> {
  const map = new Map<string, string>();
  if (!report) return map;
  report.forEach((stat: unknown) => {
    const c = stat as RawCodec;
    if (c.type === "codec" && c.id && typeof c.mimeType === "string") {
      map.set(c.id, c.mimeType);
    }
  });
  return map;
}

function mergeSenderLayer(
  layer: VideoSenderStats,
  outbound: RawOutboundRtp | undefined,
  codecMime: Map<string, string>,
): RealtimeVideoSenderStats {
  return {
    ...layer,
    qpSum: outbound?.qpSum,
    framesEncoded: outbound?.framesEncoded,
    totalEncodeTime: outbound?.totalEncodeTime,
    keyFramesEncoded: outbound?.keyFramesEncoded,
    codecMimeType: shortCodecName(outbound?.codecId ? codecMime.get(outbound.codecId) : undefined),
  };
}

function mergeReceiver(
  base: VideoReceiverStats,
  inbound: RawInboundRtp | undefined,
  codecMime: Map<string, string>,
): RealtimeVideoReceiverStats {
  const merged: RealtimeVideoReceiverStats = {
    ...base,
    qpSum: inbound?.qpSum,
    freezeCount: inbound?.freezeCount,
    totalFreezesDuration: inbound?.totalFreezesDuration,
    pauseCount: inbound?.pauseCount,
    totalPausesDuration: inbound?.totalPausesDuration,
    keyFramesDecoded: inbound?.keyFramesDecoded,
    framesPerSecond: inbound?.framesPerSecond,
    codecMimeType: shortCodecName(inbound?.codecId ? codecMime.get(inbound.codecId) : undefined),
  };
  if (typeof inbound?.framesDropped === "number") merged.framesDropped = inbound.framesDropped;
  return merged;
}

export function getDefaultVideoPublishOptions(
  videoCodec?: VideoCodec,
  overrides?: Partial<TrackPublishOptions>,
): TrackPublishOptions {
  const defaultEncoding = {
    maxBitrate: REALTIME_CONFIG.livekit.defaultMaxVideoBitrateBps,
    maxFramerate: REALTIME_CONFIG.livekit.defaultPublishFps,
  };

  return {
    source: Track.Source.Camera,
    simulcast: true,
    videoCodec: videoCodec ?? REALTIME_CONFIG.livekit.defaultVideoCodec,
    ...overrides,
    videoEncoding: {
      ...defaultEncoding,
      ...overrides?.videoEncoding,
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
  publishOptions?: Partial<TrackPublishOptions>;
  roomOptions?: Partial<RoomOptions>;
  remoteVideoElement?: HTMLVideoElement;
}

export type MediaConnectOptions = {
  url: string;
  token: string;
};

type EncodingLayerState = {
  rid: string;
  active: boolean;
  maxBitrate?: number;
  scaleResolutionDownBy?: number;
};

type LayerMonitor = {
  intervalId: ReturnType<typeof setInterval>;
  lastInactiveKey: string | null;
};

const getEncodingRid = (encoding: RTCRtpEncodingParameters, index: number): string => {
  if (encoding.rid) return encoding.rid;
  return index === 0 ? "q" : `layer-${index}`;
};

const getInactiveLayerKey = (layers: EncodingLayerState[]): string =>
  layers
    .filter((layer) => !layer.active)
    .map((layer) => layer.rid)
    .sort()
    .join(",");

export class MediaChannel {
  private room: Room | null = null;
  private remoteStream: MediaStream | null = null;
  private events: Emitter<MediaChannelEvents> = mitt();
  private layerMonitors = new Map<string, LayerMonitor>();
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
    this.room ??= new Room({
      ...REALTIME_CONFIG.livekit.roomOptions,
      ...this.config.roomOptions,
    });
    const room = this.room;

    room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _pub, participant: RemoteParticipant) => {
      if (!participant.identity.startsWith(REALTIME_CONFIG.livekit.inferenceServerIdentityPrefix)) return;
      if (track.kind !== Track.Kind.Video) return;

      if (this.config.remoteVideoElement) {
        track.attach(this.config.remoteVideoElement);
      } else {
        track.attach();
      }
      const mediaStreamTrack = track.mediaStreamTrack;
      if (mediaStreamTrack) {
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

  async getVideoStats(): Promise<RealtimeVideoStats> {
    const room = this.room;
    if (!room) return { sender: [], receiver: [] };

    const sender: RealtimeVideoSenderStats[] = [];
    for (const pub of room.localParticipant.videoTrackPublications.values()) {
      const track = pub.track;
      if (!(track instanceof LocalVideoTrack)) continue;

      let layers: VideoSenderStats[] = [];
      try {
        layers = await track.getSenderStats();
      } catch (error) {
        this.logger.debug("getSenderStats failed", { error: (error as Error).message });
      }

      let report: RTCStatsReport | null = null;
      try {
        report = (await track.getRTCStatsReport()) ?? null;
      } catch (error) {
        this.logger.debug("getRTCStatsReport (sender) failed", { error: (error as Error).message });
      }

      const codecMime = collectCodecMimeMap(report);
      const outbounds: RawOutboundRtp[] = [];
      report?.forEach((stat: unknown) => {
        const s = stat as RawOutboundRtp;
        if (s.type === "outbound-rtp" && s.kind === "video") outbounds.push(s);
      });

      for (const layer of layers) {
        const match = outbounds.find((o) => (o.rid ?? "") === (layer.rid ?? "")) ?? outbounds[0];
        sender.push(mergeSenderLayer(layer, match, codecMime));
      }
    }

    const receiver: RealtimeVideoReceiverStats[] = [];
    for (const participant of room.remoteParticipants.values()) {
      if (!participant.identity.startsWith(REALTIME_CONFIG.livekit.inferenceServerIdentityPrefix)) continue;
      for (const pub of participant.videoTrackPublications.values()) {
        const track = pub.track;
        if (!(track instanceof RemoteVideoTrack)) continue;

        let stats: VideoReceiverStats | undefined;
        try {
          stats = await track.getReceiverStats();
        } catch (error) {
          this.logger.debug("getReceiverStats failed", { error: (error as Error).message });
        }
        if (!stats) continue;

        let report: RTCStatsReport | null = null;
        try {
          report = (await track.getRTCStatsReport()) ?? null;
        } catch (error) {
          this.logger.debug("getRTCStatsReport (receiver) failed", { error: (error as Error).message });
        }

        const codecMime = collectCodecMimeMap(report);
        let inbound: RawInboundRtp | undefined;
        report?.forEach((stat: unknown) => {
          const s = stat as RawInboundRtp;
          if (!inbound && s.type === "inbound-rtp" && s.kind === "video") inbound = s;
        });

        receiver.push(mergeReceiver(stats, inbound, codecMime));
      }
    }

    return { sender, receiver };
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
    this.stopLayerMonitors();
    this.config.observability?.setLiveKitRoom(null);
    if (room) {
      room.disconnect().catch(() => {});
    }
  }

  private async publishTracks(stream: MediaStream): Promise<void> {
    if (!this.room) return;
    for (const track of stream.getVideoTracks()) {
      const publishOptions = getDefaultVideoPublishOptions(this.config.videoCodec, this.config.publishOptions);
      this.logger.info("livekit: publishing video track", {
        videoCodec: publishOptions.videoCodec,
        simulcast: publishOptions.simulcast,
        scalabilityMode: publishOptions.scalabilityMode,
        degradationPreference: publishOptions.degradationPreference,
        maxBitrate: publishOptions.videoEncoding?.maxBitrate,
        maxFramerate: publishOptions.videoEncoding?.maxFramerate,
      });
      const publication = await this.room.localParticipant.publishTrack(track, publishOptions);
      this.startLayerMonitor(publication);
    }
  }

  private startLayerMonitor(publication: LocalTrackPublication): void {
    const track = publication.videoTrack;
    if (!(track instanceof LocalVideoTrack)) return;

    const key = publication.trackSid || track.sid || track.id;
    const previous = this.layerMonitors.get(key);
    if (previous) clearInterval(previous.intervalId);

    let monitor: LayerMonitor;
    const intervalId = setInterval(
      () => this.logInactiveLayers(track, monitor),
      REALTIME_CONFIG.observability.statsDefaultIntervalMs,
    );
    monitor = { intervalId, lastInactiveKey: null };
    this.layerMonitors.set(key, monitor);
    this.logInactiveLayers(track, monitor);
  }

  private logInactiveLayers(track: LocalVideoTrack, monitor: LayerMonitor): void {
    const encodings = track.sender?.getParameters().encodings ?? [];
    if (encodings.length === 0) return;

    const layers: EncodingLayerState[] = encodings.map((encoding, index) => ({
      rid: getEncodingRid(encoding, index),
      active: encoding.active !== false,
      maxBitrate: encoding.maxBitrate,
      scaleResolutionDownBy: encoding.scaleResolutionDownBy,
    }));
    const inactiveKey = getInactiveLayerKey(layers);
    if (inactiveKey === monitor.lastInactiveKey) return;
    monitor.lastInactiveKey = inactiveKey;

    this.logger.info("livekit: simulcast layer streaming state changed", {
      inactiveLayers: inactiveKey ? inactiveKey.split(",") : [],
      layers,
    });
  }

  private stopLayerMonitors(): void {
    for (const monitor of this.layerMonitors.values()) {
      clearInterval(monitor.intervalId);
    }
    this.layerMonitors.clear();
  }
}
