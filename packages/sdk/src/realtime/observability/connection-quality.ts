import { REALTIME_CONFIG } from "../config-realtime";
import type { WebRTCStats } from "./webrtc-stats";

/**
 * Interpreted, smoothed verdict on whether the user's connection is good
 * enough for the real-time camera-up pipeline. Derived entirely from the
 * raw `WebRTCStats` the SDK already collects — no new transport or polling.
 *
 * "good" — show normally · "fair" — usable, optional subtle warning ·
 * "poor" — degraded, prominent warning · "critical" — effectively unusable.
 */
export type ConnectionQuality = "good" | "fair" | "poor" | "critical";

/** Which dimension pulled the verdict down to its current level. */
export type ConnectionQualityLimitingFactor =
  | "bandwidth" // upstream BWE below need, encoder bandwidth-limited, or low inbound bitrate
  | "latency" // RTT too high
  | "loss" // server reports too many of our packets lost
  | "stall" // rendered stream froze / fps collapsed
  | "cpu" // encoder CPU-limited (a device issue, never drags quality down)
  | "none"; // nothing limiting

/**
 * The human-meaningful numbers behind the verdict — one per scored dimension
 * (`rttMs`→latency, `packetLoss`→loss, `fps`→stall, `availableUpstreamKbps`→
 * bandwidth). For the full raw WebRTC firehose, subscribe to the `stats` event.
 */
export type ConnectionQualityMetrics = {
  /** Round-trip time in ms, or null until measured. */
  rttMs: number | null;
  /** Rendered (inbound) frames per second, or null until measured. */
  fps: number | null;
  /** Fraction (0–1) of our outbound packets the server reports lost, or null until measured. */
  packetLoss: number | null;
  /** Estimated available upstream bandwidth in kbps, or null until measured. */
  availableUpstreamKbps: number | null;
};

export type ConnectionQualityReport = {
  quality: ConnectionQuality;
  limitingFactor: ConnectionQualityLimitingFactor;
  /** True while the connection ramps; the verdict is provisional (see warmupSamples). */
  warmingUp: boolean;
  metrics: ConnectionQualityMetrics;
};

export type ConnectionQualityThresholds = {
  windowSamples: number;
  warmupSamples: number;
  downgradeConsecutive: number;
  upgradeConsecutive: number;
  rtt: { goodMs: number; fairMs: number; poorMs: number; relayExtraMs: number };
  loss: { good: number; fair: number; poor: number };
  upstream: { goodRatio: number; fairRatio: number; poorRatio: number; requiredUpstreamKbps: number };
  stall: { goodFps: number; fairFps: number; poorFps: number };
};

const RANK: Record<ConnectionQuality, number> = { critical: 0, poor: 1, fair: 2, good: 3 };

/** Worst (lowest-rank) of the given qualities. */
function worst(...qualities: ConnectionQuality[]): ConnectionQuality {
  return qualities.reduce((a, b) => (RANK[a] <= RANK[b] ? a : b));
}

/** Score a metric where lower is better (RTT, loss). `null` → "good" (absence of evidence ≠ bad). */
function scoreLowerBetter(value: number | null, good: number, fair: number, poor: number): ConnectionQuality {
  if (value === null) return "good";
  if (value <= good) return "good";
  if (value <= fair) return "fair";
  if (value <= poor) return "poor";
  return "critical";
}

/** Score a metric where higher is better (bitrate, fps). `null` → "good". */
function scoreHigherBetter(value: number | null, good: number, fair: number, poor: number): ConnectionQuality {
  if (value === null) return "good";
  if (value >= good) return "good";
  if (value >= fair) return "fair";
  if (value >= poor) return "poor";
  return "critical";
}

/**
 * Full set of raw signals the scorer needs (internal). The public report
 * exposes only a human-meaningful subset; everything here is also on `stats`.
 */
type QualitySignals = {
  rttMs: number | null;
  fractionLost: number | null;
  availableOutgoingKbps: number | null;
  fps: number | null;
  freezeCountDelta: number | null;
  qualityLimitationReason: string | null;
  isRelayed: boolean;
};

/** Pull the scoring-relevant signals out of a raw stats snapshot. */
function extractSignals(stats: WebRTCStats): QualitySignals {
  const rttSec = stats.remoteInbound?.roundTripTime ?? stats.connection.currentRoundTripTime;
  const isRelayed = stats.connection.selectedCandidatePairs.some(
    (pair) => pair.local.candidateType === "relay" || pair.remote.candidateType === "relay",
  );

  return {
    rttMs: rttSec != null ? rttSec * 1000 : null,
    fractionLost: stats.remoteInbound?.fractionLost ?? null,
    availableOutgoingKbps:
      stats.connection.availableOutgoingBitrate != null ? stats.connection.availableOutgoingBitrate / 1000 : null,
    fps: stats.video?.framesPerSecond ?? null,
    freezeCountDelta: stats.video?.freezeCountDelta ?? null,
    qualityLimitationReason: stats.outboundVideo?.qualityLimitationReason ?? null,
    isRelayed,
  };
}

type ScoreOptions = {
  /** Skip the bandwidth dimension while the connection is still ramping. */
  skipBitrate?: boolean;
};

/** Score an already-extracted (optionally smoothed) signal set. Pure. */
export function scoreMetrics(
  signals: QualitySignals,
  thresholds: ConnectionQualityThresholds,
  options: ScoreOptions = {},
): { quality: ConnectionQuality; limitingFactor: ConnectionQualityLimitingFactor } {
  const relayExtra = signals.isRelayed ? thresholds.rtt.relayExtraMs : 0;
  const latency = scoreLowerBetter(
    signals.rttMs,
    thresholds.rtt.goodMs + relayExtra,
    thresholds.rtt.fairMs + relayExtra,
    thresholds.rtt.poorMs + relayExtra,
  );

  const loss = scoreLowerBetter(signals.fractionLost, thresholds.loss.good, thresholds.loss.fair, thresholds.loss.poor);

  // Bandwidth is scored on the UPSTREAM path only, as available BWE ÷ the
  // INTENDED publish bitrate (a stable reference). We deliberately do NOT divide
  // by the encoder's current target/outbound: congestion control lowers those
  // to match a weak uplink, so the ratio would sit near 1.0 and report "good"
  // even while the stream is throttled far below intended quality.
  //
  // The DOWNSTREAM (received) bitrate is not scored at all — its value is chosen
  // by the server's encoder for the model, not by the network. Real downstream
  // trouble surfaces through the stall (fps/freezes) and loss dimensions.
  let bandwidth: ConnectionQuality = "good";
  if (!options.skipBitrate) {
    const ratio =
      signals.availableOutgoingKbps != null
        ? signals.availableOutgoingKbps / thresholds.upstream.requiredUpstreamKbps
        : null;
    bandwidth = scoreHigherBetter(
      ratio,
      thresholds.upstream.goodRatio,
      thresholds.upstream.fairRatio,
      thresholds.upstream.poorRatio,
    );
    // The encoder explicitly telling us it throttled for the network is a
    // stronger signal than the BWE ratio — cap at "fair".
    if (signals.qualityLimitationReason === "bandwidth") bandwidth = worst(bandwidth, "fair");
  }

  let stall = scoreHigherBetter(
    signals.fps,
    thresholds.stall.goodFps,
    thresholds.stall.fairFps,
    thresholds.stall.poorFps,
  );
  // A freeze this sample means the rendered stream can't be called "good".
  if (signals.freezeCountDelta != null && signals.freezeCountDelta > 0) stall = worst(stall, "fair");

  const quality = worst(bandwidth, latency, loss, stall);

  // limitingFactor: the worst network dimension (tie-break bandwidth > loss >
  // latency > stall). CPU limitation is surfaced only when the network is
  // otherwise clean — it's a device problem, never a reason to hide.
  let limitingFactor: ConnectionQualityLimitingFactor;
  if (quality === "good") {
    limitingFactor = signals.qualityLimitationReason === "cpu" ? "cpu" : "none";
  } else if (bandwidth === quality) {
    limitingFactor = "bandwidth";
  } else if (loss === quality) {
    limitingFactor = "loss";
  } else if (latency === quality) {
    limitingFactor = "latency";
  } else {
    limitingFactor = "stall";
  }

  return { quality, limitingFactor };
}

/** Convenience: extract + score a raw snapshot in one call (used in tests). */
export function scoreSnapshot(
  stats: WebRTCStats,
  thresholds: ConnectionQualityThresholds = REALTIME_CONFIG.observability.connectionQuality,
  options: ScoreOptions = {},
): { quality: ConnectionQuality; limitingFactor: ConnectionQualityLimitingFactor } {
  return scoreMetrics(extractSignals(stats), thresholds, options);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function minOrNull(values: number[]): number | null {
  return values.length === 0 ? null : Math.min(...values);
}

class RingBuffer {
  private values: number[] = [];
  constructor(private readonly size: number) {}
  push(value: number | null): void {
    if (value === null) return;
    this.values.push(value);
    if (this.values.length > this.size) this.values.shift();
  }
  median(): number | null {
    return median(this.values);
  }
  min(): number | null {
    return minOrNull(this.values);
  }
  clear(): void {
    this.values = [];
  }
}

/**
 * Stateful wrapper around the pure scorer: smooths metrics over a rolling
 * window and applies asymmetric hysteresis so the emitted level doesn't flap
 * every second. `update()` returns a report only when the debounced level
 * changes; `current()` returns the latest report at any time.
 */
export class ConnectionQualityEvaluator {
  private readonly rtt: RingBuffer;
  private readonly loss: RingBuffer;
  private readonly availableOutgoing: RingBuffer;
  private readonly fps: RingBuffer;
  private sampleCount = 0;
  private currentLevel: ConnectionQuality | null = null;
  // Captured when a level is committed so a held verdict keeps the reason that
  // produced it — not whatever the latest (possibly recovering) sample reads.
  private currentFactor: ConnectionQualityLimitingFactor = "none";
  private candidateLevel: ConnectionQuality | null = null;
  private candidateCount = 0;
  private prevWarmingUp = true;
  private lastReport: ConnectionQualityReport | null = null;

  constructor(
    private readonly thresholds: ConnectionQualityThresholds = REALTIME_CONFIG.observability.connectionQuality,
  ) {
    const w = thresholds.windowSamples;
    this.rtt = new RingBuffer(w);
    this.loss = new RingBuffer(w);
    this.availableOutgoing = new RingBuffer(w);
    this.fps = new RingBuffer(w);
  }

  /** Feed one raw stats sample. Returns a report only when the level or warm-up state changes. */
  update(stats: WebRTCStats): ConnectionQualityReport | null {
    this.sampleCount++;
    const raw = extractSignals(stats);

    this.rtt.push(raw.rttMs);
    this.loss.push(raw.fractionLost);
    this.availableOutgoing.push(raw.availableOutgoingKbps);
    this.fps.push(raw.fps);

    // Smooth the noisy signals over the window; encoder/path fields reflect the
    // latest sample, not a window aggregate.
    const smoothed: QualitySignals = {
      ...raw,
      rttMs: this.rtt.median(),
      fractionLost: this.loss.median(),
      availableOutgoingKbps: this.availableOutgoing.median(),
      fps: this.fps.min(),
    };

    const warmingUp = this.sampleCount < this.thresholds.warmupSamples;
    const { quality, limitingFactor } = scoreMetrics(smoothed, this.thresholds, { skipBitrate: warmingUp });

    // Warm-up skips bandwidth scoring while the encoder/BWE ramp. The moment it
    // ends we have a trustworthy, fully-scored verdict — commit it immediately
    // instead of letting the optimistic warm-up "good" linger through the
    // downgrade debounce, so the first non-warming report is authoritative.
    // (This also delivers that first non-provisional report to callback
    // consumers, who would otherwise stay stuck on `warmingUp: true`.)
    const warmupJustEnded = this.prevWarmingUp && !warmingUp;
    this.prevWarmingUp = warmingUp;

    let changed: boolean;
    if (warmupJustEnded) {
      changed = this.currentLevel !== quality;
      this.currentLevel = quality;
      this.candidateLevel = null;
      this.candidateCount = 0;
    } else {
      changed = this.applyHysteresis(quality);
    }

    // Capture the reason whenever the level (re)commits, so it stays in sync
    // with the quality being reported between changes.
    if (changed || warmupJustEnded) {
      this.currentFactor = quality === "good" ? (limitingFactor === "cpu" ? "cpu" : "none") : limitingFactor;
    }
    const emitted = this.currentLevel ?? quality;

    this.lastReport = {
      quality: emitted,
      limitingFactor: this.currentFactor,
      warmingUp,
      metrics: {
        rttMs: smoothed.rttMs,
        fps: smoothed.fps,
        packetLoss: smoothed.fractionLost,
        availableUpstreamKbps: smoothed.availableOutgoingKbps,
      },
    };

    return changed || warmupJustEnded ? this.lastReport : null;
  }

  current(): ConnectionQualityReport | null {
    return this.lastReport;
  }

  reset(): void {
    this.rtt.clear();
    this.loss.clear();
    this.availableOutgoing.clear();
    this.fps.clear();
    this.sampleCount = 0;
    this.currentLevel = null;
    this.currentFactor = "none";
    this.candidateLevel = null;
    this.candidateCount = 0;
    this.prevWarmingUp = true;
    this.lastReport = null;
  }

  /** Returns true if the debounced level changed this tick. */
  private applyHysteresis(raw: ConnectionQuality): boolean {
    // First verdict is emitted immediately so consumers get an initial state.
    if (this.currentLevel === null) {
      this.currentLevel = raw;
      this.candidateLevel = null;
      this.candidateCount = 0;
      return true;
    }

    if (raw === this.currentLevel) {
      this.candidateLevel = null;
      this.candidateCount = 0;
      return false;
    }

    if (raw === this.candidateLevel) {
      this.candidateCount++;
    } else {
      this.candidateLevel = raw;
      this.candidateCount = 1;
    }

    const isDowngrade = RANK[raw] < RANK[this.currentLevel];
    const required = isDowngrade ? this.thresholds.downgradeConsecutive : this.thresholds.upgradeConsecutive;
    if (this.candidateCount >= required) {
      this.currentLevel = raw;
      this.candidateLevel = null;
      this.candidateCount = 0;
      return true;
    }
    return false;
  }
}
