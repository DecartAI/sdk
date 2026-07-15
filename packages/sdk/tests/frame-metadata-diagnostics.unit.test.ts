import type { RemoteVideoTrack } from "livekit-client";
import { describe, expect, it, vi } from "vitest";

import {
  createBrowserFrameMetadataDiagnostics,
  FrameMetadataTracker,
} from "../src/realtime/browser/frame-metadata-diagnostics.js";

const PAST_WARMUP = 5_000;

function captureTimestamp(displayTimeMs: number, latencyMs: number): bigint {
  return BigInt(Math.round((performance.timeOrigin + displayTimeMs - latencyMs) * 1_000));
}

describe("FrameMetadataTracker", () => {
  it("measures time-to-first-frame from markStart to the first metadata-bearing rendered frame", () => {
    const tracker = new FrameMetadataTracker();
    tracker.markStart(performance.timeOrigin + 1_000);
    tracker.recordFrame(captureTimestamp(6_000, 300), performance.timeOrigin + 6_000);

    expect(tracker.snapshot()).toEqual({
      ttffMs: 5_000,
      medianMs: null,
      p90Ms: null,
      sampleCount: 0,
      dropRatio: null,
    });
  });

  it("computes steady-state latency percentiles after the warm-up window", () => {
    const tracker = new FrameMetadataTracker();
    tracker.markStart(performance.timeOrigin);
    tracker.recordFrame(captureTimestamp(10, 100), performance.timeOrigin + 10);

    for (const latency of [100, 200, 150, 300, 250]) {
      tracker.recordFrame(captureTimestamp(PAST_WARMUP, latency), performance.timeOrigin + PAST_WARMUP);
    }

    expect(tracker.snapshot()).toEqual({
      ttffMs: 10,
      medianMs: 200,
      p90Ms: 300,
      sampleCount: 5,
      dropRatio: null,
    });
  });

  it("averages the middle pair for an even-sized latency window", () => {
    const tracker = new FrameMetadataTracker();
    tracker.recordFrame(captureTimestamp(0, 100), performance.timeOrigin);
    for (const latency of [100, 200, 150, 300]) {
      tracker.recordFrame(captureTimestamp(PAST_WARMUP, latency), performance.timeOrigin + PAST_WARMUP);
    }

    expect(tracker.snapshot().medianMs).toBe(175);
  });

  it("ignores missing and implausible timestamps", () => {
    const tracker = new FrameMetadataTracker();
    tracker.recordFrame(0n, performance.timeOrigin);
    tracker.recordFrame(captureTimestamp(0, -1), performance.timeOrigin);
    tracker.recordFrame(captureTimestamp(0, 60_001), performance.timeOrigin);

    expect(tracker.snapshot()).toEqual({
      ttffMs: null,
      medianMs: null,
      p90Ms: null,
      sampleCount: 0,
      dropRatio: null,
    });
  });

  it("reset clears all measurements", () => {
    const tracker = new FrameMetadataTracker();
    tracker.markStart(performance.timeOrigin);
    tracker.recordFrame(captureTimestamp(100, 50), performance.timeOrigin + 100);
    tracker.reset();

    expect(tracker.snapshot()).toEqual({
      ttffMs: null,
      medianMs: null,
      p90Ms: null,
      sampleCount: 0,
      dropRatio: null,
    });
  });

  it("correlates LiveKit time-sync events and detaches the listener on reconnect", () => {
    const listeners = new Map<string, (update: { timestamp: number; rtpTimestamp: number }) => void>();
    const lookupFrameMetadata = vi.fn(({ rtpTimestamp }: { rtpTimestamp: number }) => ({
      userTimestamp: captureTimestamp(rtpTimestamp, 250),
      frameId: 0,
    }));
    const track = {
      lookupFrameMetadata,
      on: vi.fn((event: string, listener: (update: { timestamp: number; rtpTimestamp: number }) => void) => {
        listeners.set(event, listener);
      }),
      off: vi.fn((event: string) => {
        listeners.delete(event);
      }),
    } as unknown as RemoteVideoTrack;

    const diagnostics = createBrowserFrameMetadataDiagnostics();
    diagnostics.markStart();
    diagnostics.attachRemoteVideoTrack(track);

    const firstRtpTimestamp = Math.round(performance.now() + 100);
    const firstPlayout = performance.timeOrigin + firstRtpTimestamp;
    listeners.get("timeSyncUpdate")?.({ timestamp: firstPlayout, rtpTimestamp: firstRtpTimestamp });
    const steadyRtpTimestamp = firstRtpTimestamp + PAST_WARMUP;
    const steadyPlayout = performance.timeOrigin + steadyRtpTimestamp;
    listeners.get("timeSyncUpdate")?.({ timestamp: steadyPlayout, rtpTimestamp: steadyRtpTimestamp });

    expect(lookupFrameMetadata).toHaveBeenCalledWith({ rtpTimestamp: steadyRtpTimestamp });
    expect(diagnostics.snapshot()).toMatchObject({ medianMs: 250, sampleCount: 1 });

    diagnostics.markStart();
    expect(track.off).toHaveBeenCalledWith("timeSyncUpdate", expect.any(Function));
    expect(listeners.has("timeSyncUpdate")).toBe(false);
  });
});
