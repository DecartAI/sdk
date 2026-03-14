/**
 * Consolidated latency diagnostics for RT sessions.
 *
 * Bundles CompositeLatencyTracker and PixelLatencyProbe into one
 * pluggable object, keeping client.ts clean.
 */

import { type CompositeLatencyEstimate, CompositeLatencyTracker } from "./composite-latency";
import {
  type PixelLatencyEvent,
  type PixelLatencyMeasurement,
  PixelLatencyProbe,
  type PixelLatencyReport,
} from "./pixel-latency";
import { PixelLatencyStamper } from "./pixel-latency-stamper";
import type { LatencyReportMessage, OutgoingMessage } from "./types";
import type { WebRTCStats } from "./webrtc-stats";

export type LatencyDiagnosticsOptions = {
  composite?: boolean;
  pixelMarker?: boolean;
  videoElement?: HTMLVideoElement;
  sendMessage: (msg: OutgoingMessage) => void;
  onCompositeLatency: (estimate: CompositeLatencyEstimate) => void;
  onPixelLatency: (measurement: PixelLatencyMeasurement) => void;
  onPixelLatencyEvent: (event: PixelLatencyEvent) => void;
  onPixelLatencyReport: (report: PixelLatencyReport) => void;
};

export class LatencyDiagnostics {
  private compositeTracker: CompositeLatencyTracker | null = null;
  private pixelProbe: PixelLatencyProbe | null = null;
  private stamper: PixelLatencyStamper | null = null;
  private latestClientRtt: number | null = null;
  private readonly options: LatencyDiagnosticsOptions;
  private readonly onCompositeLatency: (estimate: CompositeLatencyEstimate) => void;

  constructor(options: LatencyDiagnosticsOptions) {
    this.options = options;
    this.onCompositeLatency = options.onCompositeLatency;

    if (options.composite) {
      this.compositeTracker = new CompositeLatencyTracker();
    }
  }

  /**
   * Create a stamper wrapping the camera video track.
   * Returns the processed MediaStream to use instead of the raw camera stream.
   * Call this before manager.connect() to substitute the published stream.
   * Starts the draw loop immediately so IVS gets frames from the start.
   */
  async createStamper(localStream: MediaStream): Promise<MediaStream> {
    if (!this.options.pixelMarker) return localStream;

    const videoTrack = localStream.getVideoTracks()[0];
    if (!videoTrack) return localStream;

    this.stamper = new PixelLatencyStamper(videoTrack);

    // Start the draw loop now so the canvas track produces frames immediately
    await this.stamper.start();

    // Build a new stream: processed video + original audio
    const processedStream = new MediaStream();
    for (const track of this.stamper.getProcessedStream().getVideoTracks()) {
      processedStream.addTrack(track);
    }
    for (const track of localStream.getAudioTracks()) {
      processedStream.addTrack(track);
    }

    return processedStream;
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

  /** Start pixel probing (stamper already started in createStamper). */
  async start(): Promise<void> {
    // Create and start pixel probe (deferred so stamper is available)
    if (this.options.pixelMarker && this.options.videoElement) {
      this.pixelProbe = new PixelLatencyProbe({
        sendMessage: this.options.sendMessage,
        onMeasurement: this.options.onPixelLatency,
        onEvent: this.options.onPixelLatencyEvent,
        onReport: this.options.onPixelLatencyReport,
        stamper: this.stamper ?? undefined,
      });
      this.pixelProbe.start(this.options.videoElement);
    }
  }

  /** Tear down everything. */
  stop(): void {
    this.pixelProbe?.stop();
    this.pixelProbe = null;
    this.stamper?.stop();
    this.stamper = null;
  }
}
