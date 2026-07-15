import type { RemoteVideoTrack, TrackEvent } from "livekit-client";

import type { G2GMetrics } from "../observability/g2g";
import type { GlassToGlassDiagnostics } from "../observability/realtime-observability";

const LATENCY_WINDOW = 300;
const MID_STREAM_WARMUP_MS = 2_000;
const MAX_PLAUSIBLE_MS = 60_000;

/**
 * Collects glass-to-glass latency from LiveKit frame metadata. Both the
 * publisher timestamp and the receiver synchronization-source timestamp are
 * wall-clock values, so they can be compared without client/server clock sync.
 */
export class FrameMetadataTracker {
  private readonly latencies: number[] = [];
  private startMs: number | null = null;
  private firstFrameMs: number | null = null;
  private ttffMs: number | null = null;

  markStart(nowMs: number): void {
    this.reset();
    this.startMs = nowMs;
  }

  recordFrame(userTimestampUs: bigint, playoutTimeMs: number): void {
    if (userTimestampUs <= 0n) return;

    const captureTimeMs = Number(userTimestampUs) / 1_000;
    const latencyMs = playoutTimeMs - captureTimeMs;
    if (!Number.isFinite(latencyMs) || latencyMs < 0 || latencyMs > MAX_PLAUSIBLE_MS) return;

    if (this.firstFrameMs === null) {
      this.firstFrameMs = playoutTimeMs;
      if (this.startMs !== null) this.ttffMs = Math.round(playoutTimeMs - this.startMs);
    }

    if (playoutTimeMs < this.firstFrameMs + MID_STREAM_WARMUP_MS) return;
    this.latencies.push(latencyMs);
    if (this.latencies.length > LATENCY_WINDOW) this.latencies.shift();
  }

  snapshot(): G2GMetrics {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const n = sorted.length;
    const medianMs =
      n === 0
        ? null
        : n % 2 === 0
          ? Math.round((sorted[n / 2 - 1] + sorted[n / 2]) / 2)
          : Math.round(sorted[(n - 1) / 2]);
    const p90Ms = n === 0 ? null : Math.round(sorted[Math.min(n - 1, Math.floor(0.9 * n))]);

    // The server currently propagates userTimestamp but not frameId, so a
    // frame-accurate drop ratio is unavailable. Keep the existing metric null
    // rather than manufacturing a drop signal from unmatched render callbacks.
    return { ttffMs: this.ttffMs, medianMs, p90Ms, sampleCount: n, dropRatio: null };
  }

  reset(): void {
    this.latencies.length = 0;
    this.startMs = null;
    this.firstFrameMs = null;
    this.ttffMs = null;
  }
}

const TIME_SYNC_UPDATE = "timeSyncUpdate" as TrackEvent.TimeSyncUpdate;

function createFrameReader(tracker: FrameMetadataTracker): {
  attach(track: RemoteVideoTrack): void;
  detach(): void;
  dispose(): void;
} {
  let attachedTrack: RemoteVideoTrack | null = null;

  const onTimeSyncUpdate = ({ timestamp, rtpTimestamp }: { timestamp: number; rtpTimestamp: number }) => {
    const frameMetadata = attachedTrack?.lookupFrameMetadata({ rtpTimestamp });
    if (frameMetadata) tracker.recordFrame(frameMetadata.userTimestamp, timestamp);
  };

  const detach = () => {
    attachedTrack?.off(TIME_SYNC_UPDATE, onTimeSyncUpdate);
    attachedTrack = null;
  };

  return {
    attach: (track) => {
      if (track === attachedTrack) return;
      detach();
      attachedTrack = track;
      track.on(TIME_SYNC_UPDATE, onTimeSyncUpdate);
    },
    detach,
    dispose: detach,
  };
}

export function createBrowserFrameMetadataDiagnostics(): GlassToGlassDiagnostics {
  const tracker = new FrameMetadataTracker();
  const reader = createFrameReader(tracker);

  return {
    attachRemoteVideoTrack: (track) => reader.attach(track),
    markStart: () => {
      // A reconnect can leave the previous room's track delivering frames briefly.
      // Detach it before resetting so stale frames cannot become the new TTFF.
      reader.detach();
      tracker.markStart(performance.timeOrigin + performance.now());
    },
    snapshot: () => tracker.snapshot(),
    dispose: () => reader.dispose(),
  };
}

export function createFrameMetadataWorker(): Worker {
  return new Worker(new URL("./frame-metadata-worker.js", import.meta.url));
}
