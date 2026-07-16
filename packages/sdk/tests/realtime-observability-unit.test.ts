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

  it("emits a single connection-breakdown aggregate on success with all started phases", async () => {
    const { RealtimeObservability } = await import("../src/realtime/observability/realtime-observability.js");

    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const diagnostics: { name: string; data: { attempt: number; success: boolean; phases: unknown[] } }[] = [];

    const observability = new RealtimeObservability({
      telemetryEnabled: true,
      apiKey: "test-key",
      logger,
      onDiagnostic: (event) =>
        diagnostics.push(event as { name: string; data: { attempt: number; success: boolean; phases: unknown[] } }),
    });

    observability.beginConnectionBreakdown(1, null);
    observability.startPhase("websocket-open");
    observability.endPhase("websocket-open", { success: true });
    observability.startPhase("room-join");
    observability.endPhase("room-join", { success: true });
    observability.startPhase("webrtc-handshake");
    observability.endPhase("webrtc-handshake", { success: true });
    observability.finishConnectionBreakdown({ success: true });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].name).toBe("client-session-connection-breakdown");
    expect(diagnostics[0].data.success).toBe(true);
    expect(diagnostics[0].data.attempt).toBe(1);
    expect(diagnostics[0].data.phases.map((p) => (p as { phase: string }).phase)).toEqual([
      "websocket-open",
      "room-join",
      "webrtc-handshake",
    ]);

    observability.sessionStarted("session-1");
    flushTelemetry(observability);
    observability.stop();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.diagnostics).toHaveLength(1);
    expect(body.diagnostics[0].name).toBe("client-session-connection-breakdown");
  });

  it("emits connection-breakdown with success:false and the failing phase's error on mid-connect failure", async () => {
    const { RealtimeObservability } = await import("../src/realtime/observability/realtime-observability.js");

    const diagnostics: { name: string; data: { success: boolean; error?: string; phases: unknown[] } }[] = [];
    const observability = new RealtimeObservability({
      telemetryEnabled: false,
      apiKey: "test-key",
      logger,
      onDiagnostic: (event) =>
        diagnostics.push(event as { name: string; data: { success: boolean; error?: string; phases: unknown[] } }),
    });

    observability.beginConnectionBreakdown(1, null);
    observability.startPhase("websocket-open");
    observability.endPhase("websocket-open", { success: true });
    observability.startPhase("room-join");
    observability.finishConnectionBreakdown({ success: false, error: "livekit_room_info timeout" });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].data.success).toBe(false);
    expect(diagnostics[0].data.error).toBe("livekit_room_info timeout");
    const phases = diagnostics[0].data.phases as Array<{ phase: string; success: boolean; error?: string }>;
    expect(phases.map((p) => p.phase)).toEqual(["websocket-open", "room-join"]);
    expect(phases[0].success).toBe(true);
    expect(phases[1].success).toBe(false);
    expect(phases[1].error).toBe("livekit_room_info timeout");
  });

  it("emits a separate connection-breakdown per attempt on retry", async () => {
    const { RealtimeObservability } = await import("../src/realtime/observability/realtime-observability.js");

    const diagnostics: { name: string; data: { attempt: number; success: boolean } }[] = [];
    const observability = new RealtimeObservability({
      telemetryEnabled: false,
      apiKey: "test-key",
      logger,
      onDiagnostic: (event) => diagnostics.push(event as { name: string; data: { attempt: number; success: boolean } }),
    });

    observability.beginConnectionBreakdown(1, null);
    observability.startPhase("websocket-open");
    observability.endPhase("websocket-open", { success: false, error: "boom" });
    observability.finishConnectionBreakdown({ success: false, error: "boom" });

    observability.beginConnectionBreakdown(2, null);
    observability.startPhase("websocket-open");
    observability.endPhase("websocket-open", { success: true });
    observability.finishConnectionBreakdown({ success: true });

    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0].data).toMatchObject({ attempt: 1, success: false });
    expect(diagnostics[1].data).toMatchObject({ attempt: 2, success: true });
  });

  it("includes initialImageSizeKb in connection-breakdown (number when image provided, null otherwise)", async () => {
    const { RealtimeObservability } = await import("../src/realtime/observability/realtime-observability.js");

    const diagnostics: { name: string; data: { initialImageSizeKb: number | null } }[] = [];
    const observability = new RealtimeObservability({
      telemetryEnabled: false,
      apiKey: "test-key",
      logger,
      onDiagnostic: (event) => diagnostics.push(event as { name: string; data: { initialImageSizeKb: number | null } }),
    });

    observability.beginConnectionBreakdown(1, 42);
    observability.finishConnectionBreakdown({ success: true });

    observability.beginConnectionBreakdown(2, null);
    observability.finishConnectionBreakdown({ success: true });

    expect(diagnostics[0].data.initialImageSizeKb).toBe(42);
    expect(diagnostics[1].data.initialImageSizeKb).toBeNull();
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

  it("flushes buffered telemetry when stopped before the report interval", async () => {
    const { RealtimeObservability } = await import("../src/realtime/observability/realtime-observability.js");

    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const source = {
      getStats: vi.fn().mockResolvedValue(
        new Map([
          [
            "video",
            {
              type: "inbound-rtp",
              kind: "video",
              framesPerSecond: 30,
              framesDecoded: 1,
            },
          ],
        ]) as unknown as RTCStatsReport,
      ),
    };

    const observability = new RealtimeObservability({
      telemetryEnabled: true,
      apiKey: "test-key",
      logger,
    });

    observability.sessionStarted("session-stop");
    observability.setStatsProvider(source);

    await vi.advanceTimersByTimeAsync(REALTIME_CONFIG.observability.statsDefaultIntervalMs);
    expect(fetchMock).not.toHaveBeenCalled();

    observability.stop();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].keepalive).toBe(true);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.sessionId).toBe("session-stop");
    expect(body.stats).toHaveLength(1);
  });

  it("pushes connection metrics on every stats tick while the quality verdict stays coarse", async () => {
    const { RealtimeObservability } = await import("../src/realtime/observability/realtime-observability.js");

    vi.useFakeTimers();
    // Stable, healthy stats so the verdict does not flap tick to tick.
    let framesDecoded = 0;
    const source = {
      getStats: vi.fn().mockImplementation(async () => {
        framesDecoded += 30;
        return new Map([
          ["video", { type: "inbound-rtp", kind: "video", framesPerSecond: 30, framesDecoded }],
        ]) as unknown as RTCStatsReport;
      }),
    };

    const metricsEvents: Array<Record<string, unknown>> = [];
    const qualityEvents: unknown[] = [];
    const observability = new RealtimeObservability({
      telemetryEnabled: false,
      apiKey: "test-key",
      logger,
      onConnectionMetrics: (metrics) => metricsEvents.push(metrics as Record<string, unknown>),
      onConnectionQuality: (report) => qualityEvents.push(report),
    });

    observability.setStatsProvider(source);
    const ticks = 4;
    for (let i = 0; i < ticks; i++) {
      await vi.advanceTimersByTimeAsync(REALTIME_CONFIG.observability.statsDefaultIntervalMs);
    }
    observability.stop();

    // Metrics push once per stats tick (continuous), unlike the debounced verdict.
    expect(metricsEvents).toHaveLength(ticks);
    expect(metricsEvents.length).toBeGreaterThan(qualityEvents.length);
    expect(metricsEvents[0]).toHaveProperty("g2gMs");
    expect(metricsEvents[0]).toHaveProperty("rttMs");
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

  it("keeps the same LiveKit room registered for deduplication", async () => {
    const { RealtimeObservability } = await import("../src/realtime/observability/realtime-observability.js");

    const observability = new RealtimeObservability({
      telemetryEnabled: false,
      apiKey: "test-key",
      logger,
      onStats: () => {},
    });
    const setStatsProviderSpy = vi.spyOn(observability, "setStatsProvider");
    const room = {
      localParticipant: { trackPublications: new Map() },
      remoteParticipants: new Map(),
    };

    observability.setLiveKitRoom(room as never);
    observability.setLiveKitRoom(room as never);
    observability.stop();

    expect(setStatsProviderSpy).toHaveBeenCalledTimes(1);
  });
});
