/**
 * Consolidated latency diagnostics for RT sessions.
 *
 * Bundles CompositeLatencyTracker and PixelLatencyProbe into one
 * pluggable object, keeping client.ts clean.
 */

import type { LatencyReportMessage, OutgoingMessage } from "./types";
import { CompositeLatencyTracker, type CompositeLatencyEstimate } from "./composite-latency";
import { PixelLatencyProbe, type PixelLatencyMeasurement } from "./pixel-latency";
import type { WebRTCStats } from "./webrtc-stats";

export type LatencyDiagnosticsOptions = {
  composite?: boolean;
  pixelMarker?: boolean;
  videoElement?: HTMLVideoElement;
  sendMessage: (msg: OutgoingMessage) => void;
  onCompositeLatency: (estimate: CompositeLatencyEstimate) => void;
  onPixelLatency: (measurement: PixelLatencyMeasurement) => void;
};

export class LatencyDiagnostics {
  private compositeTracker: CompositeLatencyTracker | null = null;
  private pixelProbe: PixelLatencyProbe | null = null;
  private latestClientRtt: number | null = null;
  private readonly videoElement: HTMLVideoElement | undefined;
  private readonly onCompositeLatency: (estimate: CompositeLatencyEstimate) => void;

  constructor(options: LatencyDiagnosticsOptions) {
    this.onCompositeLatency = options.onCompositeLatency;
    this.videoElement = options.videoElement;

    if (options.composite) {
      this.compositeTracker = new CompositeLatencyTracker();
    }

    if (options.pixelMarker && options.videoElement) {
      this.pixelProbe = new PixelLatencyProbe(
        options.sendMessage,
        options.onPixelLatency,
      );
    }
  }

  /** Handle incoming latency_report from server. */
  onServerReport(msg: LatencyReportMessage): void {
    if (!this.compositeTracker) return;
    this.compositeTracker.onServerReport(msg);
    const estimate = this.compositeTracker.getEstimate(this.latestClientRtt);
    if (estimate) {
      this.onCompositeLatency(estimate);
    }
  }

  /** Update client RTT from WebRTC stats. */
  onStats(stats: WebRTCStats): void {
    this.latestClientRtt = stats.connection?.currentRoundTripTime ?? null;
  }

  /** Start pixel probing (call after video is playing). */
  start(): void {
    if (this.pixelProbe && this.videoElement) {
      this.pixelProbe.start(this.videoElement);
    }
  }

  /** Tear down everything. */
  stop(): void {
    this.pixelProbe?.stop();
  }
}
