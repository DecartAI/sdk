import { describe, expect, it, vi } from "vitest";
import { classifyActiveProbe, classifyConnectivity, createPreflight } from "../src/realtime/browser/preflight.js";
import type { RealTimeClient } from "../src/realtime/client.js";
import { REALTIME_CONFIG } from "../src/realtime/config-realtime.js";
import type { ConnectivityMetrics, PreflightRttThresholds } from "../src/realtime/preflight-types.js";
import { models } from "../src/shared/model.js";

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const RTT: PreflightRttThresholds = { goodMs: 150, marginalMs: 300 };
const PROBE_THRESHOLDS = REALTIME_CONFIG.observability.connectionQuality;

function probeMetrics(overrides: Partial<ConnectivityMetrics> = {}): ConnectivityMetrics {
  return {
    transport: "udp",
    rttMs: 50,
    g2gMs: 450,
    ttffMs: 2_000,
    g2gDropRatio: 0,
    upstreamJitterMs: 5,
    packetLoss: 0,
    sampleCount: 30,
    ...overrides,
  };
}

describe("classifyConnectivity", () => {
  it("treats no connectivity as critical", () => {
    const report = classifyConnectivity({ transport: "failed", rttMs: null }, RTT);
    expect(report.quality).toBe("critical");
    expect(report.reasons.length).toBeGreaterThan(0);
    expect(report.metrics).toEqual({ transport: "failed", rttMs: null });
  });

  it("treats relay-only (UDP unconfirmed) as poor", () => {
    const report = classifyConnectivity({ transport: "relay", rttMs: 90 }, RTT);
    expect(report.quality).toBe("poor");
    expect(report.reasons.length).toBeGreaterThan(0);
  });

  it("treats direct UDP with low RTT as good", () => {
    const report = classifyConnectivity({ transport: "udp", rttMs: 100 }, RTT);
    expect(report.quality).toBe("good");
    expect(report.reasons).toHaveLength(0);
    expect(report.metrics.rttMs).toBe(100);
  });

  it("treats elevated RTT on direct UDP as fair", () => {
    const report = classifyConnectivity({ transport: "udp", rttMs: 200 }, RTT);
    expect(report.quality).toBe("fair");
  });

  it("treats very high RTT on direct UDP as poor", () => {
    const report = classifyConnectivity({ transport: "udp", rttMs: 420 }, RTT);
    expect(report.quality).toBe("poor");
  });

  it("treats direct UDP with unknown RTT as good", () => {
    const report = classifyConnectivity({ transport: "udp", rttMs: null }, RTT);
    expect(report.quality).toBe("good");
  });
});

describe("classifyActiveProbe", () => {
  it("rates a fast startup and low mid-stream latency as good with no reasons", () => {
    const report = classifyActiveProbe(probeMetrics({ ttffMs: 2_000, g2gMs: 450 }), PROBE_THRESHOLDS);
    expect(report.quality).toBe("good");
    expect(report.reasons).toHaveLength(0);
  });

  it("drives the verdict off mid-stream glass-to-glass even when RTT is low", () => {
    const report = classifyActiveProbe(probeMetrics({ rttMs: 30, g2gMs: 1800 }), PROBE_THRESHOLDS);
    expect(report.quality).toBe("critical"); // 1800ms > poor band (1500)
    expect(report.reasons.some((r) => r.includes("glass-to-glass"))).toBe(true);
  });

  it("scores time-to-first-frame separately from mid-stream latency", () => {
    // Good steady state, but a very slow cold start (12s) must pull the verdict down.
    const report = classifyActiveProbe(probeMetrics({ ttffMs: 12_000, g2gMs: 450 }), PROBE_THRESHOLDS);
    expect(report.quality).toBe("critical"); // 12s > poor band (10s)
    expect(report.reasons.some((r) => r.includes("first frame"))).toBe(true);
  });

  it("treats a ~4-5s cold start as fair, not critical", () => {
    const report = classifyActiveProbe(probeMetrics({ ttffMs: 4_500, g2gMs: 450 }), PROBE_THRESHOLDS);
    expect(report.quality).toBe("fair"); // 4.5s is within the fair band (≤6s)
  });

  it("falls back to RTT when neither latency could be measured", () => {
    const report = classifyActiveProbe(
      probeMetrics({ g2gMs: null, ttffMs: null, rttMs: 600, g2gDropRatio: null, packetLoss: null }),
      PROBE_THRESHOLDS,
    );
    expect(report.quality).toBe("critical"); // RTT 600 > poor band (500)
    expect(report.reasons.some((r) => r.includes("Could not measure"))).toBe(true);
  });

  it("flags a high end-to-end drop ratio even when latency is good", () => {
    const report = classifyActiveProbe(probeMetrics({ g2gMs: 150, g2gDropRatio: 0.2 }), PROBE_THRESHOLDS);
    expect(report.quality).toBe("critical");
  });

  it("flags high upstream packet loss", () => {
    const report = classifyActiveProbe(probeMetrics({ g2gMs: 150, packetLoss: 0.2 }), PROBE_THRESHOLDS);
    expect(report.quality).toBe("critical");
  });

  it("treats a failed connection as critical", () => {
    const report = classifyActiveProbe(probeMetrics({ transport: "failed" }), PROBE_THRESHOLDS);
    expect(report.quality).toBe("critical");
    expect(report.reasons.length).toBeGreaterThan(0);
  });

  it("returns fair (not good) when connected but nothing could be measured", () => {
    // Session established (transport udp) but the probe produced no signal at all.
    const report = classifyActiveProbe(
      probeMetrics({ g2gMs: null, ttffMs: null, rttMs: null, g2gDropRatio: null, packetLoss: null }),
      PROBE_THRESHOLDS,
    );
    expect(report.quality).toBe("fair");
    expect(report.reasons.length).toBeGreaterThan(0);
  });
});

function stubDeepProbeDom() {
  const tracks = [{ stop: vi.fn() }];
  vi.stubGlobal("document", {
    createElement: vi.fn(() => ({
      width: 0,
      height: 0,
      getContext: vi.fn(() => ({
        fillRect: vi.fn(),
        set fillStyle(_: string) {},
      })),
      captureStream: vi.fn(() => ({
        getTracks: () => tracks,
        getVideoTracks: () => tracks,
      })),
    })),
  } as unknown as Document);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 0));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
}

describe("checkConnectivity", () => {
  it("reports critical/failed when WebRTC is unavailable in the environment", async () => {
    // The vitest unit env has no RTCPeerConnection, so the probe degrades cleanly.
    const { checkConnectivity } = createPreflight({ logger });
    const report = await checkConnectivity();
    expect(report.metrics.transport).toBe("failed");
    expect(report.quality).toBe("critical");
  });

  it("returns immediately when a deep probe signal is already aborted", async () => {
    const connect = vi.fn();
    const controller = new AbortController();
    controller.abort();
    const { checkConnectivity } = createPreflight({ logger, connect });
    const report = await checkConnectivity({
      deep: true,
      model: models.realtime("lucy-restyle-2"),
      signal: controller.signal,
    });
    expect(connect).not.toHaveBeenCalled();
    expect(report.reasons).toContain("Deep connectivity probe aborted.");
  });

  it("cancels a deep probe while connect is still in flight", async () => {
    vi.useFakeTimers();
    stubDeepProbeDom();
    const disconnect = vi.fn();
    const connect = vi.fn(
      () =>
        new Promise<RealTimeClient>((resolve) => {
          setTimeout(() => resolve({ on: vi.fn(), disconnect } as unknown as RealTimeClient), 60_000);
        }),
    );
    const controller = new AbortController();
    const { checkConnectivity } = createPreflight({ logger, connect });
    const model = models.realtime("lucy-restyle-2");

    const pending = checkConnectivity({ deep: true, model, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    const report = await pending;

    expect(report.reasons).toContain("Deep connectivity probe aborted.");
    expect(connect).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(disconnect).toHaveBeenCalledOnce();

    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
});
