import { describe, expect, it } from "vitest";
import { REALTIME_CONFIG } from "../src/realtime/config-realtime.js";
import {
  ConnectionQualityEvaluator,
  type ConnectionQualityThresholds,
  scoreSnapshot,
} from "../src/realtime/observability/connection-quality.js";
import type { WebRTCStats } from "../src/realtime/observability/webrtc-stats.js";

const THRESHOLDS = REALTIME_CONFIG.observability.connectionQuality;

type StatsOverrides = {
  rttSec?: number | null;
  fractionLost?: number | null;
  availableOutgoingBitrate?: number | null;
  targetBitrateKbps?: number | null;
  outboundBitrate?: number;
  qualityLimitationReason?: string;
  downstreamBitrate?: number;
  fps?: number;
  freezeCountDelta?: number;
  relayed?: boolean;
  videoNull?: boolean;
  outboundNull?: boolean;
  remoteInboundNull?: boolean;
  g2gMs?: number;
  g2gDropRatio?: number;
};

/** Build a WebRTCStats snapshot that scores "good" by default; override per test. */
function makeStats(o: StatsOverrides = {}): WebRTCStats {
  const rttSec = o.rttSec === undefined ? 0.05 : o.rttSec;
  const relayCandidate = { candidateType: "relay", address: "", port: 0, protocol: "udp" };
  const hostCandidate = { candidateType: "host", address: "", port: 0, protocol: "udp" };
  const stats = {
    timestamp: 1000,
    video: o.videoNull
      ? null
      : {
          framesPerSecond: o.fps ?? 30,
          bitrate: o.downstreamBitrate ?? 3_000_000,
          freezeCountDelta: o.freezeCountDelta ?? 0,
        },
    audio: null,
    outboundVideo: o.outboundNull
      ? null
      : {
          bitrate: o.outboundBitrate ?? 3_000_000,
          targetBitrateKbps: o.targetBitrateKbps === undefined ? 3000 : o.targetBitrateKbps,
          qualityLimitationReason: o.qualityLimitationReason ?? "none",
        },
    remoteInbound: o.remoteInboundNull
      ? null
      : {
          // o.fractionLost is a 0–1 fraction; the real WebRTC stat is that × 256 (RFC 3550 8-bit).
          fractionLost: o.fractionLost === undefined ? 0 : o.fractionLost * 256,
          jitter: 0,
          roundTripTime: rttSec,
        },
    connection: {
      currentRoundTripTime: rttSec,
      availableOutgoingBitrate: o.availableOutgoingBitrate === undefined ? 4_000_000 : o.availableOutgoingBitrate,
      selectedCandidatePairs: o.relayed
        ? [{ local: relayCandidate, remote: relayCandidate }]
        : [{ local: hostCandidate, remote: hostCandidate }],
    },
    glassToGlass:
      o.g2gMs === undefined && o.g2gDropRatio === undefined
        ? null
        : {
            ttffMs: null,
            medianMs: o.g2gMs ?? null,
            p90Ms: null,
            sampleCount: 1,
            dropRatio: o.g2gDropRatio ?? null,
          },
  };
  return stats as unknown as WebRTCStats;
}

describe("scoreSnapshot", () => {
  it("rates a healthy snapshot as good with no limiting factor", () => {
    const { quality, limitingFactor } = scoreSnapshot(makeStats());
    expect(quality).toBe("good");
    expect(limitingFactor).toBe("none");
  });

  it("flags high RTT as a critical latency problem", () => {
    const { quality, limitingFactor } = scoreSnapshot(makeStats({ rttSec: 0.6 }));
    expect(quality).toBe("critical");
    expect(limitingFactor).toBe("latency");
  });

  it("flags high packet loss as a critical loss problem", () => {
    const { quality, limitingFactor } = scoreSnapshot(makeStats({ fractionLost: 0.2 }));
    expect(quality).toBe("critical");
    expect(limitingFactor).toBe("loss");
  });

  it("normalizes the RFC 3550 fractionLost scale (a few % loss is not critical)", () => {
    // 3% real loss (raw stat ≈ 7.7) must read "fair", not "critical".
    expect(scoreSnapshot(makeStats({ fractionLost: 0.03 })).quality).toBe("fair");
  });

  it("does not penalize a low (server-controlled) downstream bitrate on its own", () => {
    // The return-stream bitrate is chosen by the server's encoder, not the
    // network — a low-but-steady value must not read as a bad connection.
    const { quality, limitingFactor } = scoreSnapshot(makeStats({ downstreamBitrate: 500_000 }));
    expect(quality).toBe("good");
    expect(limitingFactor).toBe("none");
  });

  it("flags insufficient upstream headroom as a bandwidth problem", () => {
    // available 1 Mbps vs 3.5 Mbps intended → ratio 0.29 < 0.5 critical
    const { quality, limitingFactor } = scoreSnapshot(makeStats({ availableOutgoingBitrate: 1_000_000 }));
    expect(quality).toBe("critical");
    expect(limitingFactor).toBe("bandwidth");
  });

  it("flags throttled upstream even when the encoder target dropped to match it", () => {
    // Congestion control cut the encoder target to ~1.2 Mbps to fit a weak uplink.
    // Scoring against the intended 3.5 Mbps still flags it — the lowered target
    // must not mask the throttle as "good".
    const { quality, limitingFactor } = scoreSnapshot(
      makeStats({ availableOutgoingBitrate: 1_200_000, targetBitrateKbps: 1200 }),
    );
    expect(quality).toBe("critical");
    expect(limitingFactor).toBe("bandwidth");
  });

  it("caps upstream at fair when the encoder reports a bandwidth limitation, even with good BWE", () => {
    const { quality, limitingFactor } = scoreSnapshot(
      makeStats({ availableOutgoingBitrate: 6_000_000, qualityLimitationReason: "bandwidth" }),
    );
    expect(quality).toBe("fair");
    expect(limitingFactor).toBe("bandwidth");
  });

  it("treats a CPU-limited encoder as informational, never dragging quality down", () => {
    const { quality, limitingFactor } = scoreSnapshot(makeStats({ qualityLimitationReason: "cpu" }));
    expect(quality).toBe("good");
    expect(limitingFactor).toBe("cpu");
  });

  it("widens RTT bands on TURN-relayed paths", () => {
    // 250ms: fair on a direct path (>300? no, <=300 → fair), good once relay adds +100ms headroom
    expect(scoreSnapshot(makeStats({ rttSec: 0.25, relayed: false })).quality).toBe("fair");
    expect(scoreSnapshot(makeStats({ rttSec: 0.25, relayed: true })).quality).toBe("good");
  });

  it("skips the bandwidth dimension when skipBitrate is set (warm-up)", () => {
    const opts = { skipBitrate: true };
    // low upstream headroom: 1 Mbps available vs 3 Mbps needed → critical, unless skipped
    expect(scoreSnapshot(makeStats({ availableOutgoingBitrate: 1_000_000 }), THRESHOLDS, opts).quality).toBe("good");
    expect(scoreSnapshot(makeStats({ availableOutgoingBitrate: 1_000_000 })).quality).toBe("critical");
  });

  it("drives the latency verdict off measured glass-to-glass when present (not RTT)", () => {
    // Low RTT alone reads good, but a high measured g2g (slow model path) must
    // pull latency down — this is the whole point of the feature.
    const { quality, limitingFactor } = scoreSnapshot(makeStats({ rttSec: 0.05, g2gMs: 1800 }));
    expect(quality).toBe("critical"); // 1800ms > poor band (1500)
    expect(limitingFactor).toBe("latency");
  });

  it("rates a typical mid-stream glass-to-glass latency as good", () => {
    // ~450ms steady-state (server pipeline ~285ms + network/jitter) is good.
    expect(scoreSnapshot(makeStats({ g2gMs: 450 })).quality).toBe("good");
  });

  it("rates a good glass-to-glass latency as good even on a relayed path", () => {
    // g2g already includes the network legs, so no relay headroom is applied.
    expect(scoreSnapshot(makeStats({ g2gMs: 450, relayed: true })).quality).toBe("good");
  });

  it("falls back to RTT for latency when glass-to-glass is absent", () => {
    expect(scoreSnapshot(makeStats({ rttSec: 0.6 })).quality).toBe("critical");
  });

  it("flags a high end-to-end frame drop ratio as a stall problem", () => {
    const { quality, limitingFactor } = scoreSnapshot(makeStats({ g2gDropRatio: 0.2 }));
    expect(quality).toBe("critical"); // 20% > poor band (10%)
    expect(limitingFactor).toBe("stall");
  });

  it("treats missing metrics as good (absence of evidence is not evidence of badness)", () => {
    const allNull = makeStats({
      rttSec: null,
      remoteInboundNull: true,
      videoNull: true,
      outboundNull: true,
      availableOutgoingBitrate: null,
    });
    const { quality, limitingFactor } = scoreSnapshot(allNull);
    expect(quality).toBe("good");
    expect(limitingFactor).toBe("none");
  });
});

function fastThresholds(overrides: Partial<ConnectionQualityThresholds> = {}): ConnectionQualityThresholds {
  return {
    ...THRESHOLDS,
    windowSamples: 1,
    warmupSamples: 1,
    downgradeConsecutive: 3,
    upgradeConsecutive: 3,
    ...overrides,
  };
}

describe("ConnectionQualityEvaluator", () => {
  it("emits the first verdict immediately", () => {
    const evaluator = new ConnectionQualityEvaluator(fastThresholds());
    const report = evaluator.update(makeStats());
    expect(report?.quality).toBe("good");
  });

  it("requires consecutive samples before downgrading, then upgrading", () => {
    const evaluator = new ConnectionQualityEvaluator(fastThresholds());
    expect(evaluator.update(makeStats())?.quality).toBe("good");

    const bad = () => makeStats({ rttSec: 0.6 });
    expect(evaluator.update(bad())).toBeNull(); // 1
    expect(evaluator.update(bad())).toBeNull(); // 2
    expect(evaluator.update(bad())?.quality).toBe("critical"); // 3 → downgrade
    expect(evaluator.current()?.quality).toBe("critical");

    expect(evaluator.update(makeStats())).toBeNull(); // 1
    expect(evaluator.update(makeStats())).toBeNull(); // 2
    expect(evaluator.update(makeStats())?.quality).toBe("good"); // 3 → upgrade
  });

  it("emits again when warm-up ends, even if the level stayed good", () => {
    const evaluator = new ConnectionQualityEvaluator(fastThresholds({ warmupSamples: 3 }));
    expect(evaluator.update(makeStats())).toMatchObject({ quality: "good", warmingUp: true });
    expect(evaluator.update(makeStats())).toBeNull(); // still warming, no change
    // warm-up ends → emit the first non-provisional verdict even though quality held
    expect(evaluator.update(makeStats())).toMatchObject({ quality: "good", warmingUp: false });
    expect(evaluator.update(makeStats())).toBeNull(); // steady afterward → silent
  });

  it("snaps to the real verdict when warm-up ends (no lingering optimistic good)", () => {
    const evaluator = new ConnectionQualityEvaluator(fastThresholds({ warmupSamples: 3 }));
    const weakUplink = () => makeStats({ availableOutgoingBitrate: 800_000 }); // ~0.23 ratio → critical
    // Bandwidth is skipped during warm-up, so the provisional verdict is good.
    expect(evaluator.update(weakUplink())).toMatchObject({ quality: "good", warmingUp: true });
    expect(evaluator.update(weakUplink())).toBeNull();
    // When warm-up ends the first non-warming report must already reflect the
    // weak uplink — not stay "good" until the downgrade debounce catches up.
    expect(evaluator.update(weakUplink())).toMatchObject({
      quality: "critical",
      warmingUp: false,
      limitingFactor: "bandwidth",
    });
  });

  it("refreshes the limiting factor when the cause shifts at the same held level", () => {
    const evaluator = new ConnectionQualityEvaluator(fastThresholds());
    evaluator.update(makeStats()); // good
    evaluator.update(makeStats({ rttSec: 0.6 }));
    evaluator.update(makeStats({ rttSec: 0.6 }));
    expect(evaluator.update(makeStats({ rttSec: 0.6 }))?.limitingFactor).toBe("latency"); // critical via latency
    // Still critical, but latency recovered and bandwidth is now the culprit.
    evaluator.update(makeStats({ availableOutgoingBitrate: 500_000 }));
    expect(evaluator.current()).toMatchObject({ quality: "critical", limitingFactor: "bandwidth" });
  });

  it("keeps the limiting factor of the held verdict during recovery", () => {
    const evaluator = new ConnectionQualityEvaluator(fastThresholds());
    evaluator.update(makeStats()); // good
    const badLatency = () => makeStats({ rttSec: 0.6 });
    evaluator.update(badLatency());
    evaluator.update(badLatency());
    expect(evaluator.update(badLatency())?.quality).toBe("critical"); // downgrade
    expect(evaluator.current()?.limitingFactor).toBe("latency");

    // One good recovery sample: still debounced at critical — the reason must
    // stay "latency", not flip to "none" because the latest raw score recovered.
    expect(evaluator.update(makeStats())).toBeNull();
    expect(evaluator.current()).toMatchObject({ quality: "critical", limitingFactor: "latency" });
  });

  it("resets the debounce counter when a sample returns to the current level", () => {
    const evaluator = new ConnectionQualityEvaluator(fastThresholds());
    evaluator.update(makeStats()); // good
    const bad = () => makeStats({ rttSec: 0.6 });
    expect(evaluator.update(bad())).toBeNull(); // 1 bad
    expect(evaluator.update(bad())).toBeNull(); // 2 bad
    expect(evaluator.update(makeStats())).toBeNull(); // good resets counter
    expect(evaluator.update(bad())).toBeNull(); // 1 bad again
    expect(evaluator.update(bad())).toBeNull(); // 2 bad
    expect(evaluator.update(bad())?.quality).toBe("critical"); // 3 → downgrade
  });

  it("stays provisional and ignores bandwidth during warm-up, then scores it after", () => {
    const evaluator = new ConnectionQualityEvaluator(fastThresholds({ warmupSamples: 3, downgradeConsecutive: 1 }));
    const lowUp = () => makeStats({ availableOutgoingBitrate: 1_000_000 });

    const first = evaluator.update(lowUp());
    expect(first?.quality).toBe("good");
    expect(first?.warmingUp).toBe(true);

    expect(evaluator.update(lowUp())).toBeNull(); // still warming, still good
    expect(evaluator.current()?.warmingUp).toBe(true);

    const afterWarmup = evaluator.update(lowUp()); // sample 3 → warm-up over, bandwidth counts
    expect(afterWarmup?.warmingUp).toBe(false);
    expect(afterWarmup?.quality).toBe("critical");
  });

  it("reset() clears all state", () => {
    const evaluator = new ConnectionQualityEvaluator(fastThresholds());
    evaluator.update(makeStats({ rttSec: 0.6 }));
    evaluator.reset();
    expect(evaluator.current()).toBeNull();
    // first verdict after reset emits again
    expect(evaluator.update(makeStats())?.quality).toBe("good");
  });
});
