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
    /**
     * Selected ICE candidate pairs (usually one per PC). Populated from
     * the `candidate-pair` report with state="succeeded" plus the matching
     * `local-candidate` / `remote-candidate` lookups. Lets diagnostic tools
     * tell direct-UDP sessions from TURN-relayed ones — the path affects
     * jitter and failure modes, so this is essential signal for
     * benchmarking and incident triage.
     */
    selectedCandidatePairs: Array<{
      local: IceCandidateInfo;
      remote: IceCandidateInfo;
    }>;
  };
};

/** One side of an ICE candidate pair (sender or receiver). */
export type IceCandidateInfo = {
  /** "host" | "srflx" | "prflx" | "relay" */
  candidateType: string;
  /** IP (v4 or v6). May be `""` for mDNS-obfuscated host candidates. */
  address: string;
  port: number;
  /** "udp" | "tcp" */
  protocol: string;
};

export type StatsOptions = {
  /** Polling interval in milliseconds. Default: 1000. Minimum: 500. */
  intervalMs?: number;
};

/**
 * Transport-agnostic source of `RTCStatsReport`. `RTCPeerConnection` already
 * satisfies it (its `getStats()` returns `Promise<RTCStatsReport>`); the
 * LiveKit transport provides a custom adapter that aggregates per-track stats
 * from the room. See `transports/livekit.ts` for the livekit impl.
 */
export interface StatsProvider {
  getStats(): Promise<RTCStatsReport>;
}

const DEFAULT_INTERVAL_MS = 1000;
const MIN_INTERVAL_MS = 500;

export class WebRTCStatsCollector {
  private source: StatsProvider | null = null;
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

  /** Attach to a stats provider (RTCPeerConnection or equivalent) and start polling. */
  start(source: StatsProvider, onStats: (stats: WebRTCStats) => void): void {
    this.stop();
    this.source = source;
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
    this.source = null;
    this.onStats = null;
  }

  isRunning(): boolean {
    return this.intervalId !== null;
  }

  private async collect(): Promise<void> {
    if (!this.source || !this.onStats) return;

    try {
      const rawStats = await this.source.getStats();
      const stats = this.parse(rawStats);
      this.onStats(stats);
    } catch {
      // Source might be closed; stop silently
      this.stop();
    }
  }

  private parse(rawStats: RTCStatsReport): WebRTCStats {
    const now = performance.now();
    const elapsed = this.prevTimestamp > 0 ? (now - this.prevTimestamp) / 1000 : 0;

    // Explicit NonNullable aliases so TypeScript can track field
    // mutations inside the `forEach` closure below — otherwise it narrows
    // the `| null` union to `never` after the first assignment.
    type OutboundVideo = NonNullable<WebRTCStats["outboundVideo"]>;
    let video: WebRTCStats["video"] = null;
    let audio: WebRTCStats["audio"] = null;
    let outboundVideo: OutboundVideo | null = null;
    const connection: WebRTCStats["connection"] = {
      currentRoundTripTime: null,
      availableOutgoingBitrate: null,
      selectedCandidatePairs: [],
    };

    // First pass — collect succeeded candidate-pair IDs. Resolving them
    // into local/remote candidate objects happens after the main forEach
    // so we have access to every report (ordering of rawStats is not
    // guaranteed: a succeeded pair's local-candidate may appear before
    // or after it).
    const succeededPairs: Array<{ localId: string; remoteId: string }> = [];

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
        // Simulcast produces one outbound-rtp report per spatial layer
        // (3 layers is common). Earlier versions picked whichever layer
        // `forEach` visited last, which (a) underreports total outbound
        // traffic and (b) causes bitrate to go violently negative across
        // ticks because layer byte counters are independent and the "last
        // visited" layer alternates. Accumulate byte/packet totals across
        // every layer; pick scalar fields (resolution, fps, quality-
        // limitation reason) from the highest-resolution layer so the
        // reported frame size matches what's actually on the wire.
        const r = report as Record<string, unknown>;
        const bytesSent = (r.bytesSent as number) ?? 0;
        const packetsSent = (r.packetsSent as number) ?? 0;
        const frameWidth = (r.frameWidth as number) ?? 0;
        const frameHeight = (r.frameHeight as number) ?? 0;
        const pixels = frameWidth * frameHeight;

        if (outboundVideo === null) {
          outboundVideo = {
            qualityLimitationReason: (r.qualityLimitationReason as string) ?? "none",
            qualityLimitationDurations: (r.qualityLimitationDurations as Record<string, number>) ?? {},
            bytesSent,
            packetsSent,
            framesPerSecond: (r.framesPerSecond as number) ?? 0,
            frameWidth,
            frameHeight,
            bitrate: 0,
          };
        } else {
          outboundVideo.bytesSent += bytesSent;
          outboundVideo.packetsSent += packetsSent;
          // Promote scalar fields whenever a higher-resolution layer
          // appears — we want reported resolution to match the largest
          // active layer, not the lowest.
          if (pixels > outboundVideo.frameWidth * outboundVideo.frameHeight) {
            outboundVideo.frameWidth = frameWidth;
            outboundVideo.frameHeight = frameHeight;
            outboundVideo.framesPerSecond = (r.framesPerSecond as number) ?? 0;
            outboundVideo.qualityLimitationReason = (r.qualityLimitationReason as string) ?? "none";
            outboundVideo.qualityLimitationDurations =
              (r.qualityLimitationDurations as Record<string, number>) ?? {};
          }
        }
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
          const localId = r.localCandidateId as string | undefined;
          const remoteId = r.remoteCandidateId as string | undefined;
          if (localId && remoteId) {
            succeededPairs.push({ localId, remoteId });
          }
        }
      }
    });

    // Resolve candidate IDs to their local/remote-candidate reports now
    // that we've seen every entry in the rawStats map. `rawStats.get()`
    // is O(1) on the spec-compliant Map, so per-pair resolution is cheap.
    if (succeededPairs.length > 0) {
      const toInfo = (id: string): IceCandidateInfo | null => {
        const c = (rawStats as unknown as Map<string, unknown>).get(id) as
          | Record<string, unknown>
          | undefined;
        if (!c) return null;
        return {
          // browsers may report `ip` (older spec) or `address` (newer). Prefer `address`.
          candidateType: (c.candidateType as string) ?? "",
          address: ((c.address as string) ?? (c.ip as string) ?? "") as string,
          port: (c.port as number) ?? 0,
          protocol: (c.protocol as string) ?? "",
        };
      };
      for (const { localId, remoteId } of succeededPairs) {
        const local = toInfo(localId);
        const remote = toInfo(remoteId);
        if (local && remote) {
          connection.selectedCandidatePairs.push({ local, remote });
        }
      }
    }

    // Compute outbound video bitrate after the loop, now that we know
    // the summed bytesSent across all simulcast layers. Doing it per-
    // report would misattribute deltas to whichever layer came last.
    //
    // Cast via `unknown` because TypeScript can't track the non-null
    // assignment inside the forEach closure above — flow analysis sees
    // only the initial `let outboundVideo = null` and narrows to `never`.
    const ov = outboundVideo as unknown as OutboundVideo | null;
    if (ov !== null) {
      const outBitrate =
        elapsed > 0 ? ((ov.bytesSent - this.prevBytesSentVideo) * 8) / elapsed : 0;
      // Clamp to zero: when tracks are added/removed mid-session (new
      // simulcast layer, publisher swap) total bytesSent can transiently
      // drop. Negative bitrate is nonsensical to downstream consumers.
      ov.bitrate = Math.max(0, Math.round(outBitrate));
      this.prevBytesSentVideo = ov.bytesSent;
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
