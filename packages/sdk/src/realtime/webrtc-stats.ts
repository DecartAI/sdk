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
    /** Cumulative NACK (retransmission request) count from inbound-rtp. */
    nackCount: number;
    /** Delta: NACKs since previous sample (≈ NACK rate per polling interval). */
    nackCountDelta: number;
    /** Cumulative FIR (Full Intra Request) count sent by the receiver. */
    firCount: number;
    /** Cumulative PLI (Picture Loss Indication) count sent by the receiver. */
    pliCount: number;
    /** Total frames received (before decode). */
    framesReceived: number;
    /** Average inter-frame delay in ms (computed by the browser). */
    avgInterFrameDelayMs: number;
    /** Variance of inter-frame delay in ms. */
    interFrameDelayVarianceMs: number;
    /** Jitter buffer target delay in ms. */
    jitterBufferTargetDelayMs: number;
    /** Jitter buffer minimum delay in ms (set via minDelay). */
    jitterBufferMinimumDelayMs: number;
    /** Average decode time per frame in ms (totalDecodeTime / framesDecoded). */
    avgDecodeTimeMs: number;
    /** Average jitter buffer delay in ms (jitterBufferDelay / jitterBufferEmittedCount). */
    avgJitterBufferMs: number;
    /** Average processing delay in ms (totalProcessingDelay / framesDecoded). */
    avgProcessingDelayMs: number;
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
    /** Cumulative NACK count received from the remote end (server asking us to retransmit). */
    nackCount: number;
    /** Cumulative FIR count received from the remote end. */
    firCount: number;
    /** Cumulative PLI count received from the remote end. */
    pliCount: number;
    /** Cumulative retransmitted bytes sent. */
    retransmittedBytesSent: number;
    /** Cumulative retransmitted packets sent. */
    retransmittedPacketsSent: number;
    /** Encoder target bitrate in kbps, or null if unavailable. */
    targetBitrateKbps: number | null;
    /** Average packet send delay in ms (capture to wire). */
    avgPacketSendDelayMs: number;
    /** Average encode time per frame in ms (totalEncodeTime / framesEncoded). */
    avgEncodeTimeMs: number;
  } | null;
  connection: {
    /** Current round-trip time in seconds, or null if unavailable. */
    currentRoundTripTime: number | null;
    /** Available outgoing bitrate estimate in bits/sec, or null if unavailable. */
    availableOutgoingBitrate: number | null;
    /** Selected candidate pairs from succeeded ICE negotiations (one per PeerConnection). */
    selectedCandidatePairs: Array<{
      local: { address: string; port: number; protocol: string; candidateType: string };
      remote: { address: string; port: number; protocol: string; candidateType: string };
    }>;
  };
};

export type StatsOptions = {
  /** Polling interval in milliseconds. Default: 1000. Minimum: 500. */
  intervalMs?: number;
};

const DEFAULT_INTERVAL_MS = 1000;
const MIN_INTERVAL_MS = 500;

export class StatsParser {
  private prevBytesVideo = 0;
  private prevBytesAudio = 0;
  private prevBytesSentVideo = 0;
  private prevTimestamp = 0;
  // Previous cumulative values for delta computation
  private prevPacketsLostVideo = 0;
  private prevFramesDropped = 0;
  private prevFreezeCount = 0;
  private prevFreezeDuration = 0;
  private prevNackCount = 0;
  private prevPacketsLostAudio = 0;

  /** Reset all delta-tracking state to zero. */
  reset(): void {
    this.prevBytesVideo = 0;
    this.prevBytesAudio = 0;
    this.prevBytesSentVideo = 0;
    this.prevTimestamp = 0;
    this.prevPacketsLostVideo = 0;
    this.prevFramesDropped = 0;
    this.prevFreezeCount = 0;
    this.prevFreezeDuration = 0;
    this.prevNackCount = 0;
    this.prevPacketsLostAudio = 0;
  }

  parse(rawStats: RTCStatsReport): WebRTCStats {
    const now = performance.now();
    const elapsed = this.prevTimestamp > 0 ? (now - this.prevTimestamp) / 1000 : 0;

    let video: WebRTCStats["video"] = null;
    let audio: WebRTCStats["audio"] = null;
    let outboundVideo: WebRTCStats["outboundVideo"] = null;
    // Pre-collect candidate entries so candidate-pair can reference them
    type CandidateInfo = { address: string; port: number; protocol: string; candidateType: string };
    const candidateMap = new Map<string, CandidateInfo>();
    rawStats.forEach((report) => {
      if (report.type === "remote-candidate" || report.type === "local-candidate") {
        const r = report as Record<string, unknown>;
        const addr = r.address as string | undefined;
        if (addr) {
          candidateMap.set(r.id as string, {
            address: addr,
            port: (r.port as number) ?? 0,
            protocol: (r.protocol as string) ?? "udp",
            candidateType: (r.candidateType as string) ?? "unknown",
          });
        }
      }
    });

    const connection: WebRTCStats["connection"] = {
      currentRoundTripTime: null,
      availableOutgoingBitrate: null,
      selectedCandidatePairs: [],
    };

    rawStats.forEach((report) => {
      if (report.type === "inbound-rtp" && report.kind === "video") {
        const bytesReceived = ((report as Record<string, unknown>).bytesReceived as number) ?? 0;
        const bitrate = elapsed > 0 ? ((bytesReceived - this.prevBytesVideo) * 8) / elapsed : 0;
        this.prevBytesVideo = bytesReceived;

        const r = report as Record<string, unknown>;
        const packetsLost = (r.packetsLost as number) ?? 0;
        const framesDropped = (r.framesDropped as number) ?? 0;
        const freezeCount = (r.freezeCount as number) ?? 0;
        const freezeDuration = (r.totalFreezesDuration as number) ?? 0;
        const nackCount = (r.nackCount as number) ?? 0;

        // Jitter buffer delay: compute from cumulative emitted count + delay
        const jbEmitted = (r.jitterBufferEmittedCount as number) ?? 0;
        const jbDelay = (r.jitterBufferDelay as number) ?? 0;
        const jbTargetDelay = (r.jitterBufferTargetDelay as number) ?? 0;
        const jbMinDelay = (r.jitterBufferMinimumDelay as number) ?? 0;
        const jbTargetMs = jbEmitted > 0 ? (jbTargetDelay / jbEmitted) * 1000 : 0;
        const jbMinMs = jbEmitted > 0 ? (jbMinDelay / jbEmitted) * 1000 : 0;

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
          nackCount,
          nackCountDelta: Math.max(0, nackCount - this.prevNackCount),
          firCount: (r.firCount as number) ?? 0,
          pliCount: (r.pliCount as number) ?? 0,
          framesReceived: (r.framesReceived as number) ?? 0,
          avgInterFrameDelayMs: ((r.totalInterFrameDelay as number) ?? 0) > 0 && (r.framesDecoded as number) > 0
            ? ((r.totalInterFrameDelay as number) / (r.framesDecoded as number)) * 1000
            : 0,
          interFrameDelayVarianceMs: ((r.totalSquaredInterFrameDelay as number) ?? 0) > 0 && (r.framesDecoded as number) > 0
            ? Math.sqrt((r.totalSquaredInterFrameDelay as number) / (r.framesDecoded as number)) * 1000
            : 0,
          jitterBufferTargetDelayMs: jbTargetMs,
          jitterBufferMinimumDelayMs: jbMinMs,
          avgDecodeTimeMs: (r.framesDecoded as number) > 0
            ? ((r.totalDecodeTime as number) ?? 0) / (r.framesDecoded as number) * 1000
            : 0,
          avgJitterBufferMs: jbEmitted > 0 ? (jbDelay / jbEmitted) * 1000 : 0,
          avgProcessingDelayMs: (r.framesDecoded as number) > 0
            ? ((r.totalProcessingDelay as number) ?? 0) / (r.framesDecoded as number) * 1000
            : 0,
        };
        this.prevPacketsLostVideo = packetsLost;
        this.prevFramesDropped = framesDropped;
        this.prevFreezeCount = freezeCount;
        this.prevFreezeDuration = freezeDuration;
        this.prevNackCount = nackCount;
      }

      if (report.type === "outbound-rtp" && report.kind === "video") {
        const r = report as Record<string, unknown>;
        const bytesSent = (r.bytesSent as number) ?? 0;
        const outBitrate = elapsed > 0 ? ((bytesSent - this.prevBytesSentVideo) * 8) / elapsed : 0;
        this.prevBytesSentVideo = bytesSent;

        // Average packet send delay: totalPacketSendDelay / packetsSent (seconds → ms)
        const pktsSent = (r.packetsSent as number) ?? 0;
        const totalPktSendDelay = (r.totalPacketSendDelay as number) ?? 0;
        const avgPktSendDelayMs = pktsSent > 0 ? (totalPktSendDelay / pktsSent) * 1000 : 0;

        outboundVideo = {
          qualityLimitationReason: (r.qualityLimitationReason as string) ?? "none",
          qualityLimitationDurations: (r.qualityLimitationDurations as Record<string, number>) ?? {},
          bytesSent,
          packetsSent: pktsSent,
          framesPerSecond: (r.framesPerSecond as number) ?? 0,
          frameWidth: (r.frameWidth as number) ?? 0,
          frameHeight: (r.frameHeight as number) ?? 0,
          bitrate: Math.round(outBitrate),
          nackCount: (r.nackCount as number) ?? 0,
          firCount: (r.firCount as number) ?? 0,
          pliCount: (r.pliCount as number) ?? 0,
          retransmittedBytesSent: (r.retransmittedBytesSent as number) ?? 0,
          retransmittedPacketsSent: (r.retransmittedPacketsSent as number) ?? 0,
          targetBitrateKbps: (r.targetBitrate as number) != null ? (r.targetBitrate as number) / 1000 : null,
          avgPacketSendDelayMs: avgPktSendDelayMs,
          avgEncodeTimeMs: (r.framesEncoded as number) > 0
            ? ((r.totalEncodeTime as number) ?? 0) / (r.framesEncoded as number) * 1000
            : 0,
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
          // Resolve selected candidate pair
          const localCandId = r.localCandidateId as string | undefined;
          const remoteCandId = r.remoteCandidateId as string | undefined;
          const local = localCandId ? candidateMap.get(localCandId) : undefined;
          const remote = remoteCandId ? candidateMap.get(remoteCandId) : undefined;
          if (local && remote) {
            connection.selectedCandidatePairs.push({ local, remote });
          }
        }
      }
    });

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

export class WebRTCStatsCollector {
  private pc: RTCPeerConnection | null = null;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private parser = new StatsParser();
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
    this.parser.reset();
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
      const stats = this.parser.parse(rawStats);
      this.onStats(stats);
    } catch {
      // PC might be closed; stop silently
      this.stop();
    }
  }
}
