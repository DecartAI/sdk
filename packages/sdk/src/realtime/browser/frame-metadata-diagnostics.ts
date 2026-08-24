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

type LiveKitFrameMetadata = {
  userTimestamp: bigint;
  frameId?: number;
};

type FrameMetadataTrack = RemoteVideoTrack & {
  lookupFrameMetadata?: (options: { rtpTimestamp: number }) => LiveKitFrameMetadata | undefined;
};

function createFrameReader(tracker: FrameMetadataTracker): {
  attach(track: RemoteVideoTrack): void;
  detach(): void;
  dispose(): void;
} {
  let attachedTrack: RemoteVideoTrack | null = null;

  const onTimeSyncUpdate = ({ timestamp, rtpTimestamp }: { timestamp: number; rtpTimestamp: number }) => {
    const frameMetadata = (attachedTrack as FrameMetadataTrack | null)?.lookupFrameMetadata?.({ rtpTimestamp });
    // `timestamp` is the sync-source playout time, already specified as
    // `performance.timeOrigin + performance.now()` (epoch ms), so it lines up
    // with the publisher's epoch `userTimestamp` and the epoch `startMs` as-is.
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

const WORKER_URL = () => new URL("./frame-metadata-worker.js", import.meta.url);

export function createFrameMetadataWorker(): Worker {
  return new Worker(WORKER_URL());
}

// A cross-origin worker script (SDK served from a CDN) can't load: Chrome throws,
// Firefox/Safari hand back a worker that dies async and breaks the room. Exported
// for tests; non-http(s) URLs (bundler-inlined, tests) aren't restricted.
export function isFrameMetadataWorkerSameOrigin(workerUrl: URL, pageOrigin: string | undefined): boolean {
  if (workerUrl.protocol !== "http:" && workerUrl.protocol !== "https:") return true;
  return workerUrl.origin === pageOrigin;
}

export function isFrameMetadataRuntimeSupported(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (!isFrameMetadataWorkerSameOrigin(WORKER_URL(), window.location?.origin)) return false;
  } catch {
    return false;
  }
  const maybeWindow = window as typeof window & {
    RTCRtpScriptTransform?: unknown;
    RTCRtpSender?: { prototype?: { createEncodedStreams?: unknown } };
    RTCRtpReceiver?: { prototype?: { createEncodedStreams?: unknown } };
  };
  const userAgent = window.navigator?.userAgent?.toLowerCase() ?? "";
  const isChromiumBased = /(?:chrome|chromium|crmo)\//.test(userAgent) && !/crios\//.test(userAgent);
  const scriptTransformSupported = typeof maybeWindow.RTCRtpScriptTransform !== "undefined" && !isChromiumBased;
  const insertableStreamsSupported =
    typeof maybeWindow.RTCRtpSender?.prototype?.createEncodedStreams !== "undefined" &&
    typeof maybeWindow.RTCRtpReceiver?.prototype?.createEncodedStreams !== "undefined";
  return scriptTransformSupported || insertableStreamsSupported;
}
