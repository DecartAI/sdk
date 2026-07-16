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
    // LiveKit's timeSyncUpdate `timestamp` is the sync-source playout time as a
    // DOMHighResTimeStamp (relative to performance.timeOrigin), whereas
    // userTimestamp is epoch microseconds. The reader must reconcile the two,
    // so drive the event with a relative timestamp like the real SDK does.
    const LATENCY_MS = 250;
    let nextUserTimestampUs = 0n;
    const lookupFrameMetadata = vi.fn(() => ({ userTimestamp: nextUserTimestampUs, frameId: 0 }));
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

    const emit = (playoutRelMs: number, rtpTimestamp: number) => {
      nextUserTimestampUs = BigInt(Math.round((performance.timeOrigin + playoutRelMs - LATENCY_MS) * 1_000));
      listeners.get("timeSyncUpdate")?.({ timestamp: playoutRelMs, rtpTimestamp });
    };

    const startRel = performance.now();
    emit(startRel, 1); // first frame within warm-up → sets TTFF only
    emit(startRel + PAST_WARMUP, 2); // steady-state sample

    expect(lookupFrameMetadata).toHaveBeenCalledWith({ rtpTimestamp: 2 });
    expect(diagnostics.snapshot()).toMatchObject({ medianMs: LATENCY_MS, sampleCount: 1 });

    diagnostics.markStart();
    expect(track.off).toHaveBeenCalledWith("timeSyncUpdate", expect.any(Function));
    expect(listeners.has("timeSyncUpdate")).toBe(false);
  });
});
