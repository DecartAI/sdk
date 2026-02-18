export type WebRTCStats = {
  timestamp: number;
  video: {
    framesDecoded: number;
    framesDropped: number;
    framesPerSecond: number;
    frameWidth: number;
    frameHeight: number;
    bytesReceived: number;
    packetsReceived: number;
    packetsLost: number;
    jitter: number;
    /** Estimated inbound bitrate in bits/sec, computed from bytesReceived delta. */
    bitrate: number;
    freezeCount: number;
    totalFreezesDuration: number;
    /** Delta: packets lost since previous sample. */
    packetsLostDelta: number;
    /** Delta: frames dropped since previous sample. */
    framesDroppedDelta: number;
    /** Delta: freeze count since previous sample. */
    freezeCountDelta: number;
    /** Delta: freeze duration (seconds) since previous sample. */
    freezeDurationDelta: number;
  } | null;
  audio: {
    bytesReceived: number;
    packetsReceived: number;
    packetsLost: number;
    jitter: number;
    /** Estimated inbound bitrate in bits/sec, computed from bytesReceived delta. */
    bitrate: number;
    /** Delta: packets lost since previous sample. */
    packetsLostDelta: number;
  } | null;
  /** Outbound video track stats (from the local camera/screen share being sent). */
  outboundVideo: {
    /** Why the encoder is limiting quality: "none", "bandwidth", "cpu", or "other". */
    qualityLimitationReason: string;
    /** Cumulative time (seconds) spent in each quality limitation state. */
    qualityLimitationDurations: Record<string, number>;
    bytesSent: number;
    packetsSent: number;
    framesPerSecond: number;
    frameWidth: number;
    frameHeight: number;
    /** Estimated outbound bitrate in bits/sec, computed from bytesSent delta. */
    bitrate: number;
  } | null;
  connection: {
    /** Current round-trip time in seconds, or null if unavailable. */
    currentRoundTripTime: number | null;
    /** Available outgoing bitrate estimate in bits/sec, or null if unavailable. */
    availableOutgoingBitrate: number | null;
  };
};

export type StatsOptions = {
  /** Polling interval in milliseconds. Default: 1000. Minimum: 500. */
  intervalMs?: number;
};

const DEFAULT_INTERVAL_MS = 1000;
const MIN_INTERVAL_MS = 500;

export class WebRTCStatsCollector {
  private pc: RTCPeerConnection | null = null;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private prevBytesVideo = 0;
  private prevBytesAudio = 0;
  private prevBytesSentVideo = 0;
  private prevTimestamp = 0;
  // Previous cumulative values for delta computation
  private prevPacketsLostVideo = 0;
  private prevFramesDropped = 0;
  private prevFreezeCount = 0;
  private prevFreezeDuration = 0;
  private prevPacketsLostAudio = 0;
  private onStats: ((stats: WebRTCStats) => void) | null = null;
  private intervalMs: number;

  constructor(options: StatsOptions = {}) {
    this.intervalMs = Math.max(options.intervalMs ?? DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS);
  }

  /** Attach to a peer connection and start polling. */
  start(pc: RTCPeerConnection, onStats: (stats: WebRTCStats) => void): void {
    this.stop();
    this.pc = pc;
    this.onStats = onStats;
    this.prevBytesVideo = 0;
    this.prevBytesAudio = 0;
    this.prevBytesSentVideo = 0;
    this.prevTimestamp = 0;
    this.prevPacketsLostVideo = 0;
    this.prevFramesDropped = 0;
    this.prevFreezeCount = 0;
    this.prevFreezeDuration = 0;
    this.prevPacketsLostAudio = 0;
    this.intervalId = setInterval(() => this.collect(), this.intervalMs);
  }

  /** Stop polling and release resources. */
  stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.pc = null;
    this.onStats = null;
  }

  isRunning(): boolean {
    return this.intervalId !== null;
  }

  private async collect(): Promise<void> {
    if (!this.pc || !this.onStats) return;

    try {
      const rawStats = await this.pc.getStats();
      const stats = this.parse(rawStats);
      this.onStats(stats);
    } catch {
      // PC might be closed; stop silently
      this.stop();
    }
  }

  private parse(rawStats: RTCStatsReport): WebRTCStats {
    const now = performance.now();
    const elapsed = this.prevTimestamp > 0 ? (now - this.prevTimestamp) / 1000 : 0;

    let video: WebRTCStats["video"] = null;
    let audio: WebRTCStats["audio"] = null;
    let outboundVideo: WebRTCStats["outboundVideo"] = null;
    const connection: WebRTCStats["connection"] = {
      currentRoundTripTime: null,
      availableOutgoingBitrate: null,
    };

    for (const report of rawStats.values()) {
      if (report.type === "inbound-rtp" && report.kind === "video") {
        const bytesReceived = ((report as Record<string, unknown>).bytesReceived as number) ?? 0;
        const bitrate = elapsed > 0 ? ((bytesReceived - this.prevBytesVideo) * 8) / elapsed : 0;
        this.prevBytesVideo = bytesReceived;

        const r = report as Record<string, unknown>;
        const packetsLost = (r.packetsLost as number) ?? 0;
        const framesDropped = (r.framesDropped as number) ?? 0;
        const freezeCount = (r.freezeCount as number) ?? 0;
        const freezeDuration = (r.totalFreezesDuration as number) ?? 0;

        video = {
          framesDecoded: (r.framesDecoded as number) ?? 0,
          framesDropped,
          framesPerSecond: (r.framesPerSecond as number) ?? 0,
          frameWidth: (r.frameWidth as number) ?? 0,
          frameHeight: (r.frameHeight as number) ?? 0,
          bytesReceived,
          packetsReceived: (r.packetsReceived as number) ?? 0,
          packetsLost,
          jitter: (r.jitter as number) ?? 0,
          bitrate: Math.round(bitrate),
          freezeCount,
          totalFreezesDuration: freezeDuration,
          packetsLostDelta: Math.max(0, packetsLost - this.prevPacketsLostVideo),
          framesDroppedDelta: Math.max(0, framesDropped - this.prevFramesDropped),
          freezeCountDelta: Math.max(0, freezeCount - this.prevFreezeCount),
          freezeDurationDelta: Math.max(0, freezeDuration - this.prevFreezeDuration),
        };
        this.prevPacketsLostVideo = packetsLost;
        this.prevFramesDropped = framesDropped;
        this.prevFreezeCount = freezeCount;
        this.prevFreezeDuration = freezeDuration;
      }

      if (report.type === "outbound-rtp" && report.kind === "video") {
        const r = report as Record<string, unknown>;
        const bytesSent = (r.bytesSent as number) ?? 0;
        const outBitrate = elapsed > 0 ? ((bytesSent - this.prevBytesSentVideo) * 8) / elapsed : 0;
        this.prevBytesSentVideo = bytesSent;

        outboundVideo = {
          qualityLimitationReason: (r.qualityLimitationReason as string) ?? "none",
          qualityLimitationDurations: (r.qualityLimitationDurations as Record<string, number>) ?? {},
          bytesSent,
          packetsSent: (r.packetsSent as number) ?? 0,
          framesPerSecond: (r.framesPerSecond as number) ?? 0,
          frameWidth: (r.frameWidth as number) ?? 0,
          frameHeight: (r.frameHeight as number) ?? 0,
          bitrate: Math.round(outBitrate),
        };
      }

      if (report.type === "inbound-rtp" && report.kind === "audio") {
        const bytesReceived = ((report as Record<string, unknown>).bytesReceived as number) ?? 0;
        const bitrate = elapsed > 0 ? ((bytesReceived - this.prevBytesAudio) * 8) / elapsed : 0;
        this.prevBytesAudio = bytesReceived;

        const r = report as Record<string, unknown>;
        const audioPacketsLost = (r.packetsLost as number) ?? 0;
        audio = {
          bytesReceived,
          packetsReceived: (r.packetsReceived as number) ?? 0,
          packetsLost: audioPacketsLost,
          jitter: (r.jitter as number) ?? 0,
          bitrate: Math.round(bitrate),
          packetsLostDelta: Math.max(0, audioPacketsLost - this.prevPacketsLostAudio),
        };
        this.prevPacketsLostAudio = audioPacketsLost;
      }

      if (report.type === "candidate-pair") {
        const r = report as Record<string, unknown>;
        if (r.state === "succeeded") {
          connection.currentRoundTripTime = (r.currentRoundTripTime as number) ?? null;
          connection.availableOutgoingBitrate = (r.availableOutgoingBitrate as number) ?? null;
        }
      }
    }

    this.prevTimestamp = now;

    return {
      timestamp: Date.now(),
      video,
      audio,
      outboundVideo,
      connection,
    };
  }
}
