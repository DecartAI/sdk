import type { Logger } from "../../utils/logger";
import type { DiagnosticEvent, DiagnosticEventName, DiagnosticEvents } from "./diagnostics";
import { type ITelemetryReporter, NullTelemetryReporter, TelemetryReporter } from "./telemetry-reporter";
import { type StatsProvider, type WebRTCStats, WebRTCStatsCollector } from "./webrtc-stats";

const STALL_FPS_THRESHOLD = 0.5;

export type RealtimeObservabilityOptions = {
  telemetryEnabled: boolean;
  apiKey: string;
  model?: string;
  integration?: string;
  logger: Logger;
  onDiagnostic?: (event: DiagnosticEvent) => void;
  onStats?: (stats: WebRTCStats) => void;
};

type PendingTelemetryDiagnostic = {
  name: DiagnosticEvent["name"];
  data: DiagnosticEvent["data"];
  timestamp: number;
};

export class RealtimeObservability {
  private telemetryReporter: ITelemetryReporter = new NullTelemetryReporter();
  private telemetryReporterReady = false;
  private pendingTelemetryDiagnostics: PendingTelemetryDiagnostic[] = [];
  private statsCollector: WebRTCStatsCollector | null = null;
  private statsCollectorSource: StatsProvider | null = null;
  private videoStalled = false;
  private stallStartMs = 0;

  constructor(private readonly options: RealtimeObservabilityOptions) {}

  diagnostic<K extends DiagnosticEventName>(name: K, data: DiagnosticEvents[K], timestamp: number = Date.now()): void {
    this.options.logger.debug(name, data as Record<string, unknown>);
    this.options.onDiagnostic?.({ name, data } as DiagnosticEvent);
    this.addTelemetryDiagnostic(name, data, timestamp);
  }

  sessionStarted(sessionId: string): void {
    if (!this.options.telemetryEnabled) {
      return;
    }

    if (this.telemetryReporterReady) {
      this.telemetryReporter.stop();
    }

    const reporter = new TelemetryReporter({
      apiKey: this.options.apiKey,
      sessionId,
      model: this.options.model,
      integration: this.options.integration,
      logger: this.options.logger,
    });
    reporter.start();
    this.telemetryReporter = reporter;
    this.telemetryReporterReady = true;

    for (const diagnostic of this.pendingTelemetryDiagnostics) {
      this.telemetryReporter.addDiagnostic(diagnostic);
    }
    this.pendingTelemetryDiagnostics.length = 0;
  }

  setStatsProvider(source: StatsProvider | null): void {
    if (!source) {
      this.stopStats();
      return;
    }

    if (source === this.statsCollectorSource) {
      return;
    }

    this.stopStats();
    this.resetStallDetection();
    this.statsCollectorSource = source;

    if (!this.options.telemetryEnabled && !this.options.onStats) {
      return;
    }

    this.statsCollector = new WebRTCStatsCollector();
    this.statsCollector.start(source, (stats) => this.handleStats(stats));
  }

  stopStats(): void {
    this.statsCollector?.stop();
    this.statsCollector = null;
    this.statsCollectorSource = null;
    this.resetStallDetection();
  }

  stop(): void {
    this.stopStats();
    this.telemetryReporter.stop();
    this.telemetryReporter = new NullTelemetryReporter();
    this.telemetryReporterReady = false;
    this.pendingTelemetryDiagnostics.length = 0;
  }

  private handleStats(stats: WebRTCStats): void {
    this.options.onStats?.(stats);
    this.telemetryReporter.addStats(stats);
    this.detectVideoStall(stats);
  }

  private detectVideoStall(stats: WebRTCStats): void {
    const fps = stats.video?.framesPerSecond ?? 0;
    if (!this.videoStalled && stats.video && fps < STALL_FPS_THRESHOLD) {
      this.videoStalled = true;
      this.stallStartMs = Date.now();
      this.diagnostic("videoStall", { stalled: true, durationMs: 0 }, this.stallStartMs);
    } else if (this.videoStalled && fps >= STALL_FPS_THRESHOLD) {
      const durationMs = Date.now() - this.stallStartMs;
      this.videoStalled = false;
      this.diagnostic("videoStall", { stalled: false, durationMs });
    }
  }

  private addTelemetryDiagnostic<K extends DiagnosticEventName>(
    name: K,
    data: DiagnosticEvents[K],
    timestamp: number,
  ): void {
    if (!this.options.telemetryEnabled) {
      return;
    }

    const diagnostic = { name, data, timestamp } as PendingTelemetryDiagnostic;
    if (!this.telemetryReporterReady) {
      this.pendingTelemetryDiagnostics.push(diagnostic);
      return;
    }

    this.telemetryReporter.addDiagnostic(diagnostic);
  }

  private resetStallDetection(): void {
    this.videoStalled = false;
    this.stallStartMs = 0;
  }
}
