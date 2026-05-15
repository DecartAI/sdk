import { afterEach, describe, expect, it, vi } from "vitest";
import { REALTIME_CONFIG } from "../src/realtime/config-realtime.js";

const logger = { debug() {}, info() {}, warn() {}, error() {} };

const emptyStatsReport = () => new Map() as unknown as RTCStatsReport;

type FlushableTelemetryReporter = {
  flush: () => void;
};

type RealtimeObservabilityWithTelemetry = {
  telemetryReporter: FlushableTelemetryReporter;
};

const flushTelemetry = (observability: unknown) => {
  (observability as RealtimeObservabilityWithTelemetry).telemetryReporter.flush();
};

type NamedDiagnostic = {
  name: string;
};

describe("RealtimeObservability", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("emits diagnostics immediately and buffers them for telemetry until the session starts", async () => {
    const { RealtimeObservability } = await import("../src/realtime/observability/realtime-observability.js");

    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const diagnostics: unknown[] = [];

    const observability = new RealtimeObservability({
      telemetryEnabled: true,
      apiKey: "test-key",
      model: "lucy-2.1",
      logger,
      onDiagnostic: (event) => diagnostics.push(event),
    });

    observability.diagnostic("phaseTiming", { phase: "websocket", durationMs: 12, success: true }, 1000);

    expect(diagnostics).toEqual([{ name: "phaseTiming", data: { phase: "websocket", durationMs: 12, success: true } }]);
    expect(fetchMock).not.toHaveBeenCalled();

    observability.sessionStarted("session-1");
    flushTelemetry(observability);
    observability.stop();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.sessionId).toBe("session-1");
    expect(body.diagnostics).toEqual([
      {
        name: "phaseTiming",
        data: { phase: "websocket", durationMs: 12, success: true },
        timestamp: 1000,
      },
    ]);
  });

  it("emits stats, reports them to telemetry, and emits video stall diagnostics", async () => {
    const { RealtimeObservability } = await import("../src/realtime/observability/realtime-observability.js");

    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const diagnostics: unknown[] = [];
    const statsEvents: unknown[] = [];

    let fps = 0;
    const source = {
      getStats: vi.fn().mockImplementation(async () => {
        return new Map([
          [
            "video",
            {
              type: "inbound-rtp",
              kind: "video",
              framesPerSecond: fps,
              framesDecoded: 1,
            },
          ],
        ]) as unknown as RTCStatsReport;
      }),
    };

    const observability = new RealtimeObservability({
      telemetryEnabled: true,
      apiKey: "test-key",
      logger,
      onDiagnostic: (event) => diagnostics.push(event),
      onStats: (stats) => statsEvents.push(stats),
    });

    observability.sessionStarted("session-2");
    observability.setStatsProvider(source);

    await vi.advanceTimersByTimeAsync(REALTIME_CONFIG.observability.statsDefaultIntervalMs);
    fps = 30;
    await vi.advanceTimersByTimeAsync(REALTIME_CONFIG.observability.statsDefaultIntervalMs);

    flushTelemetry(observability);
    observability.stop();

    expect(statsEvents).toHaveLength(2);
    expect(diagnostics).toEqual([
      { name: "videoStall", data: { stalled: true, durationMs: 0 } },
      {
        name: "videoStall",
        data: { stalled: false, durationMs: expect.any(Number) },
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.stats).toHaveLength(2);
    expect(body.diagnostics.map((event: NamedDiagnostic) => event.name)).toEqual(["videoStall", "videoStall"]);
  });

  it("replaces the stats provider without leaving the old polling loop running", async () => {
    const { RealtimeObservability } = await import("../src/realtime/observability/realtime-observability.js");

    vi.useFakeTimers();
    const firstSource = { getStats: vi.fn().mockResolvedValue(emptyStatsReport()) };
    const secondSource = { getStats: vi.fn().mockResolvedValue(emptyStatsReport()) };

    const observability = new RealtimeObservability({
      telemetryEnabled: false,
      apiKey: "test-key",
      logger,
      onStats: () => {},
    });

    observability.setStatsProvider(firstSource);
    await vi.advanceTimersByTimeAsync(REALTIME_CONFIG.observability.statsDefaultIntervalMs);

    observability.setStatsProvider(secondSource);
    await vi.advanceTimersByTimeAsync(REALTIME_CONFIG.observability.statsDefaultIntervalMs);

    observability.stop();

    expect(firstSource.getStats).toHaveBeenCalledTimes(1);
    expect(secondSource.getStats).toHaveBeenCalledTimes(1);
  });
});
