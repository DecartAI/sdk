import type { Room } from "livekit-client";
import type { Logger } from "../../utils/logger";
import { REALTIME_CONFIG } from "../config-realtime";
import { ConnectionQualityEvaluator, type ConnectionQualityReport } from "./connection-quality";
import type {
  ClientSessionConnectionBreakdownPhase,
  DiagnosticEvent,
  DiagnosticEventName,
  DiagnosticEvents,
} from "./diagnostics";
import { createMarkerReader, createStampPump, type MarkerReader, SeqTracker, type StampPump } from "./glass-to-glass";
import { createLiveKitStatsProvider } from "./livekit-stats-provider";
import { type ITelemetryReporter, NullTelemetryReporter, TelemetryReporter } from "./telemetry-reporter";
import { type StatsProvider, type WebRTCStats, WebRTCStatsCollector } from "./webrtc-stats";

export type RealtimeObservabilityOptions = {
  telemetryEnabled: boolean;
  apiKey: string;
  model?: string;
  integration?: string;
  logger: Logger;
  onDiagnostic?: (event: DiagnosticEvent) => void;
  onStats?: (stats: WebRTCStats) => void;
  onConnectionQuality?: (report: ConnectionQualityReport) => void;
  /** Opt-in diagnostic: measure true glass-to-glass latency via the pixel-marker pipeline (visible marker). */
  debugQuality?: boolean;
};

type PendingTelemetryDiagnostic = {
  name: DiagnosticEvent["name"];
  data: DiagnosticEvent["data"];
  timestamp: number;
};

type PhaseEntry = {
  startedAt: number;
  endedAt?: number;
  success?: boolean;
  error?: string;
};

type ConnectionBreakdownBuffer = {
  attempt: number;
  connectStartedAt: number;
  initialImageSizeKb: number | null;
  phases: Map<string, PhaseEntry>;
};

export class RealtimeObservability {
  private telemetryReporter: ITelemetryReporter = new NullTelemetryReporter();
  private telemetryReporterReady = false;
  private pendingTelemetryDiagnostics: PendingTelemetryDiagnostic[] = [];
  private statsCollector: WebRTCStatsCollector | null = null;
  private statsCollectorSource: StatsProvider | null = null;
  private liveKitRoom: Room | null = null;
  private videoStalled = false;
  private stallStartMs = 0;
  private connectionBreakdown: ConnectionBreakdownBuffer | null = null;
  private readonly connectionQuality = new ConnectionQualityEvaluator();
  /** Glass-to-glass: shared tracker, outgoing stamp pump, and incoming reader. Null unless `debugQuality`. */
  private readonly seqTracker: SeqTracker | null;
  private readonly markerReader: MarkerReader | null;
  private stampPump: StampPump | null = null;

  constructor(private readonly options: RealtimeObservabilityOptions) {
    this.seqTracker = options.debugQuality ? new SeqTracker() : null;
    this.markerReader = this.seqTracker ? createMarkerReader(this.seqTracker) : null;
  }

  /**
   * Wrap the outgoing stream so each frame carries a marker, feeding the shared
   * tracker that the reader matches against. Returns the stream to publish
   * (unchanged when g2g is off or stamping can't start). Owned here so the
   * writer and reader of the tracker share one lifecycle and survive reconnects.
   */
  attachOutgoingStream(stream: MediaStream, fps: number): MediaStream {
    if (!this.seqTracker) return stream;
    try {
      this.stampPump = createStampPump(stream, { tracker: this.seqTracker, fps });
      return this.stampPump.stream;
    } catch (error) {
      this.options.logger.warn("Failed to start glass-to-glass stamp pump; continuing without it", {
        error: error instanceof Error ? error.message : String(error),
      });
      return stream;
    }
  }

  /** Feed the remote video track to the marker reader (called from the media channel). */
  attachRemoteVideoTrack(track: MediaStreamTrack): void {
    this.markerReader?.attach(track);
  }

  /**
   * Mark the start of a connect attempt for glass-to-glass timing (resets the
   * tracker and starts the TTFF clock). Called at the top of each connect/
   * reconnect so TTFF measures the full setup→first-frame wait. No-op unless g2g
   * measurement is on.
   */
  markGlassToGlassStart(): void {
    this.seqTracker?.markStart(performance.now());
  }

  diagnostic<K extends DiagnosticEventName>(name: K, data: DiagnosticEvents[K], timestamp: number = Date.now()): void {
    this.options.logger.debug(name, data as Record<string, unknown>);
    this.options.onDiagnostic?.({ name, data } as DiagnosticEvent);
    this.addTelemetryDiagnostic(name, data, timestamp);
  }

  beginConnectionBreakdown(attempt: number, initialImageSizeKb: number | null): void {
    this.connectionBreakdown = {
      attempt,
      connectStartedAt: Date.now(),
      initialImageSizeKb,
      phases: new Map(),
    };
  }

  startPhase(name: string): void {
    if (!this.connectionBreakdown) return;
    this.connectionBreakdown.phases.set(name, { startedAt: Date.now() });
  }

  endPhase(name: string, opts: { success: boolean; error?: string }): void {
    if (!this.connectionBreakdown) return;
    const entry = this.connectionBreakdown.phases.get(name);
    if (!entry) {
      this.options.logger.warn("observability: endPhase called for unknown phase", { phase: name });
      return;
    }
    entry.endedAt = Date.now();
    entry.success = opts.success;
    if (opts.error !== undefined) entry.error = opts.error;
  }

  finishConnectionBreakdown(opts: { success: boolean; error?: string }): void {
    const buffer = this.connectionBreakdown;
    if (!buffer) return;
    this.connectionBreakdown = null;

    const now = Date.now();
    const phases: ClientSessionConnectionBreakdownPhase[] = [];
    for (const [phase, entry] of buffer.phases) {
      const unfinished = entry.endedAt === undefined;
      const endedAt = entry.endedAt ?? now;
      const success = entry.success ?? false;
      const error = entry.error ?? (unfinished && !opts.success ? opts.error : undefined);
      phases.push({
        phase,
        durationMs: endedAt - entry.startedAt,
        success,
        ...(error !== undefined ? { error } : {}),
      });
    }

    this.diagnostic(
      "client-session-connection-breakdown",
      {
        attempt: buffer.attempt,
        success: opts.success,
        totalDurationMs: now - buffer.connectStartedAt,
        initialImageSizeKb: buffer.initialImageSizeKb,
        phases,
        ...(opts.error !== undefined ? { error: opts.error } : {}),
      },
      now,
    );
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

    if (!this.options.telemetryEnabled && !this.options.onStats && !this.options.onConnectionQuality) {
      return;
    }

    this.statsCollector = new WebRTCStatsCollector();
    this.statsCollector.start(source, (stats) => this.handleStats(stats));
  }

  setLiveKitRoom(room: Room | null): void {
    if (!room) {
      this.liveKitRoom = null;
      this.setStatsProvider(null);
      return;
    }

    if (room === this.liveKitRoom) {
      return;
    }

    this.setStatsProvider(createLiveKitStatsProvider(room));
    this.liveKitRoom = room;
  }

  stopStats(): void {
    this.statsCollector?.stop();
    this.statsCollector = null;
    this.statsCollectorSource = null;
    this.liveKitRoom = null;
    this.resetStallDetection();
  }

  stop(): void {
    this.stopStats();
    this.stampPump?.dispose();
    this.markerReader?.dispose();
    this.telemetryReporter.stop();
    this.telemetryReporter = new NullTelemetryReporter();
    this.telemetryReporterReady = false;
    this.pendingTelemetryDiagnostics.length = 0;
    this.connectionBreakdown = null;
  }

  getConnectionQuality(): ConnectionQualityReport | null {
    return this.connectionQuality.current();
  }

  private handleStats(stats: WebRTCStats): void {
    if (this.seqTracker) stats.glassToGlass = this.seqTracker.snapshot();
    this.options.onStats?.(stats);
    this.telemetryReporter.addStats(stats);
    this.detectVideoStall(stats);
    const report = this.connectionQuality.update(stats);
    if (report) this.options.onConnectionQuality?.(report);
  }

  private detectVideoStall(stats: WebRTCStats): void {
    const fps = stats.video?.framesPerSecond ?? 0;
    if (!this.videoStalled && stats.video && fps < REALTIME_CONFIG.observability.stallFpsThreshold) {
      this.videoStalled = true;
      this.stallStartMs = Date.now();
      this.diagnostic("videoStall", { stalled: true, durationMs: 0 }, this.stallStartMs);
    } else if (this.videoStalled && fps >= REALTIME_CONFIG.observability.stallFpsThreshold) {
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
    // A reconnect re-enters warm-up; don't blend pre/post-reconnect networks.
    this.connectionQuality.reset();
    // Note: the g2g tracker is reset via markGlassToGlassStart() at the start of
    // each connect attempt, NOT here — this runs mid-connect (on room attach) and
    // would otherwise wipe the TTFF start clock set moments earlier.
  }
}
