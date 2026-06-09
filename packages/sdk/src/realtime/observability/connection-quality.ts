import { REALTIME_CONFIG } from "../config-realtime";
import type { WebRTCStats } from "./webrtc-stats";

/**
 * Smoothed verdict on whether the connection is good enough for the realtime
 * pipeline, derived from the raw `WebRTCStats` the SDK already collects.
 *
 * Note: the bandwidth dimension relies on Chromium-only stats
 * (`availableOutgoingBitrate`), so on Safari/Firefox the verdict reflects
 * latency, loss, and fps only.
 */
export type ConnectionQuality = "good" | "fair" | "poor" | "critical";

/** Which dimension pulled the verdict down to its current level. */
export type ConnectionQualityLimitingFactor = "bandwidth" | "latency" | "loss" | "stall" | "cpu" | "none";

/** Human-meaningful numbers behind the verdict; the full raw stats are on the `stats` event. */
export type ConnectionQualityMetrics = {
  /** Round-trip time in ms, or null until measured. */
  rttMs: number | null;
  /**
   * Mid-stream (steady-state) glass-to-glass latency (ms) — the real per-frame
   * camera→display latency through the model, excluding startup. Only populated
   * when the opt-in pixel-marker measurement is on (`connect({ deep: true })`)
   * and past warm-up; null otherwise. When present it drives the latency verdict
   * instead of `rttMs`.
   */
  g2gMs: number | null;
  /**
   * Time-to-first-frame (ms) — startup latency from connect to the first rendered
   * model frame. One-shot; populated under g2g measurement once the first frame
   * arrives. Surfaced for visibility; does not drive the live verdict (it's
   * historical by the time a verdict exists).
   */
  ttffMs: number | null;
  /** Rendered (inbound) frames per second, or null until measured. */
  fps: number | null;
  /** Fraction (0–1) of our outbound packets the server reports lost, or null until measured. */
  packetLoss: number | null;
  /** Server's view of upstream (client→server) jitter in ms, or null. Observational. */
  upstreamJitterMs: number | null;
  /**
   * End-to-end frame drop ratio (0–1) inferred from the pixel-marker seq stream.
   * Only populated under the opt-in g2g measurement; null otherwise.
   */
  g2gDropRatio: number | null;
  /** Estimated available upstream bandwidth in kbps. Chromium-only — null on Safari/Firefox. */
  availableUpstreamKbps: number | null;
};

export type ConnectionQualityReport = {
  quality: ConnectionQuality;
  limitingFactor: ConnectionQualityLimitingFactor;
  /** True while the connection ramps; the verdict is provisional. */
  warmingUp: boolean;
  metrics: ConnectionQualityMetrics;
};

export type ConnectionQualityThresholds = {
  windowSamples: number;
  warmupSamples: number;
  downgradeConsecutive: number;
  upgradeConsecutive: number;
  rtt: { goodMs: number; fairMs: number; poorMs: number; relayExtraMs: number };
  glassToGlass: { goodMs: number; fairMs: number; poorMs: number };
  ttff: { goodMs: number; fairMs: number; poorMs: number };
  loss: { good: number; fair: number; poor: number };
  g2gDrop: { good: number; fair: number; poor: number };
  upstream: { goodRatio: number; fairRatio: number; poorRatio: number; requiredUpstreamKbps: number };
  stall: { goodFps: number; fairFps: number; poorFps: number };
};

export const RANK: Record<ConnectionQuality, number> = { critical: 0, poor: 1, fair: 2, good: 3 };

export function worst(...qualities: ConnectionQuality[]): ConnectionQuality {
  return qualities.reduce((a, b) => (RANK[a] <= RANK[b] ? a : b));
}

// A null metric scores "good" — absence of evidence is not evidence of badness.
export function scoreLowerBetter(value: number | null, good: number, fair: number, poor: number): ConnectionQuality {
  if (value === null) return "good";
  if (value <= good) return "good";
  if (value <= fair) return "fair";
  if (value <= poor) return "poor";
  return "critical";
}

function scoreHigherBetter(value: number | null, good: number, fair: number, poor: number): ConnectionQuality {
  if (value === null) return "good";
  if (value >= good) return "good";
  if (value >= fair) return "fair";
  if (value >= poor) return "poor";
  return "critical";
}

/** Full set of raw signals the scorer needs; the public report exposes a subset. */
export type QualitySignals = {
  rttMs: number | null;
  g2gMs: number | null;
  ttffMs: number | null;
  upstreamJitterMs: number | null;
  fractionLost: number | null;
  g2gDropRatio: number | null;
  availableOutgoingKbps: number | null;
  fps: number | null;
  freezeCountDelta: number | null;
  qualityLimitationReason: string | null;
  isRelayed: boolean;
};

export function extractSignals(stats: WebRTCStats): QualitySignals {
  const rttSec = stats.remoteInbound?.roundTripTime ?? stats.connection.currentRoundTripTime;
  const isRelayed = stats.connection.selectedCandidatePairs.some(
    (pair) => pair.local.candidateType === "relay" || pair.remote.candidateType === "relay",
  );

  return {
    rttMs: rttSec != null ? rttSec * 1000 : null,
    g2gMs: stats.glassToGlass?.medianMs ?? null,
    ttffMs: stats.glassToGlass?.ttffMs ?? null,
    // remote-inbound jitter is the server's view of our uplink; seconds → ms.
    upstreamJitterMs: stats.remoteInbound?.jitter != null ? stats.remoteInbound.jitter * 1000 : null,
    // WebRTC reports fractionLost as the RFC 3550 8-bit value (loss × 256); normalize to a 0–1 fraction.
    fractionLost: stats.remoteInbound?.fractionLost != null ? stats.remoteInbound.fractionLost / 256 : null,
    g2gDropRatio: stats.glassToGlass?.dropRatio ?? null,
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
  // Prefer measured glass-to-glass — the real experienced latency — when the
  // opt-in pixel-marker measurement is active. It already includes both network
  // legs, so relay headroom doesn't apply. Fall back to RTT otherwise.
  const relayExtra = signals.isRelayed ? thresholds.rtt.relayExtraMs : 0;
  const latency =
    signals.g2gMs != null
      ? scoreLowerBetter(
          signals.g2gMs,
          thresholds.glassToGlass.goodMs,
          thresholds.glassToGlass.fairMs,
          thresholds.glassToGlass.poorMs,
        )
      : scoreLowerBetter(
          signals.rttMs,
          thresholds.rtt.goodMs + relayExtra,
          thresholds.rtt.fairMs + relayExtra,
          thresholds.rtt.poorMs + relayExtra,
        );

  const loss = scoreLowerBetter(signals.fractionLost, thresholds.loss.good, thresholds.loss.fair, thresholds.loss.poor);

  // Upstream only: available BWE ÷ the INTENDED publish bitrate. Dividing by the
  // encoder's adaptive target would mask throttling (it drops with the uplink).
  // Downstream bitrate is intentionally not scored — it's server-chosen.
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
    // Encoder self-reporting a bandwidth limit is a stronger signal than the ratio.
    if (signals.qualityLimitationReason === "bandwidth") bandwidth = worst(bandwidth, "fair");
  }

  let stall = scoreHigherBetter(
    signals.fps,
    thresholds.stall.goodFps,
    thresholds.stall.fairFps,
    thresholds.stall.poorFps,
  );
  if (signals.freezeCountDelta != null && signals.freezeCountDelta > 0) stall = worst(stall, "fair");
  // End-to-end frame drops (server backpressure / overload, or transit loss)
  // surface as the same user-visible symptom as a low frame rate.
  const drop = scoreLowerBetter(
    signals.g2gDropRatio,
    thresholds.g2gDrop.good,
    thresholds.g2gDrop.fair,
    thresholds.g2gDrop.poor,
  );
  stall = worst(stall, drop);

  const quality = worst(bandwidth, latency, loss, stall);

  // Worst network dimension (tie-break bandwidth > loss > latency > stall). "cpu"
  // is informational and only surfaces when the network is otherwise clean.
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
 * Smooths metrics over a rolling window and applies asymmetric hysteresis so the
 * emitted level doesn't flap. `update()` returns a report only when the level or
 * warm-up state changes; `current()` returns the latest at any time.
 */
export class ConnectionQualityEvaluator {
  private readonly rtt: RingBuffer;
  private readonly glassToGlass: RingBuffer;
  private readonly loss: RingBuffer;
  private readonly availableOutgoing: RingBuffer;
  private readonly fps: RingBuffer;
  private sampleCount = 0;
  private currentLevel: ConnectionQuality | null = null;
  // Reason for the current verdict; refreshed to the live cause, but held across a
  // recovery lag (bad level still debounced while the latest sample improved).
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
    this.glassToGlass = new RingBuffer(w);
    this.loss = new RingBuffer(w);
    this.availableOutgoing = new RingBuffer(w);
    this.fps = new RingBuffer(w);
  }

  /** Feed one raw stats sample. Returns a report only when the level or warm-up state changes. */
  update(stats: WebRTCStats): ConnectionQualityReport | null {
    this.sampleCount++;
    const raw = extractSignals(stats);

    this.rtt.push(raw.rttMs);
    this.glassToGlass.push(raw.g2gMs);
    this.loss.push(raw.fractionLost);
    this.availableOutgoing.push(raw.availableOutgoingKbps);
    this.fps.push(raw.fps);

    // `upstreamJitterMs` (observational, unscored) and `g2gDropRatio` (already
    // windowed by the SeqTracker) ride through from `raw` un-resmoothed.
    const smoothed: QualitySignals = {
      ...raw,
      rttMs: this.rtt.median(),
      g2gMs: this.glassToGlass.median(),
      fractionLost: this.loss.median(),
      availableOutgoingKbps: this.availableOutgoing.median(),
      fps: this.fps.min(),
    };

    const warmingUp = this.sampleCount < this.thresholds.warmupSamples;
    const { quality, limitingFactor } = scoreMetrics(smoothed, this.thresholds, { skipBitrate: warmingUp });

    // Warm-up skips bandwidth scoring; when it ends, commit the fully-scored verdict
    // immediately so the first non-warming report is authoritative, rather than
    // holding the optimistic "good" through the downgrade debounce.
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

    const emitted = this.currentLevel ?? quality;

    // limitingFactor explains why we're at `emitted`: nothing when good; otherwise
    // the current worst dimension — but keep the last committed reason while a bad
    // level is held and the latest sample has already recovered above it.
    if (emitted === "good") {
      this.currentFactor = smoothed.qualityLimitationReason === "cpu" ? "cpu" : "none";
    } else if (RANK[quality] <= RANK[emitted]) {
      this.currentFactor = limitingFactor;
    }

    this.lastReport = {
      quality: emitted,
      limitingFactor: this.currentFactor,
      warmingUp,
      metrics: {
        rttMs: smoothed.rttMs,
        g2gMs: smoothed.g2gMs,
        // ttffMs (one-shot startup), upstreamJitterMs (observational), and
        // g2gDropRatio (already windowed) are surfaced raw, not re-smoothed.
        ttffMs: raw.ttffMs,
        fps: smoothed.fps,
        packetLoss: smoothed.fractionLost,
        upstreamJitterMs: raw.upstreamJitterMs,
        g2gDropRatio: raw.g2gDropRatio,
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
    this.glassToGlass.clear();
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
    if (this.currentLevel === null) {
      this.currentLevel = raw; // first verdict — emit immediately
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
