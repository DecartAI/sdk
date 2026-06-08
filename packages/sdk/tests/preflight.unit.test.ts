import { describe, expect, it } from "vitest";
import { classifyConnectivity, createPreflight, type PreflightRttThresholds } from "../src/realtime/preflight.js";

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const RTT: PreflightRttThresholds = { goodMs: 150, marginalMs: 300 };

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

describe("checkConnectivity", () => {
  it("reports critical/failed when WebRTC is unavailable in the environment", async () => {
    // The vitest unit env has no RTCPeerConnection, so the probe degrades cleanly.
    const { checkConnectivity } = createPreflight({ logger });
    const report = await checkConnectivity();
    expect(report.metrics.transport).toBe("failed");
    expect(report.quality).toBe("critical");
  });
});
