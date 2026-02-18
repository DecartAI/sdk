import { buildAuthHeaders } from "../shared/request";
import type { Logger } from "../utils/logger";
import { VERSION } from "../version";
import type { WebRTCStats } from "./webrtc-stats";

const DEFAULT_REPORT_INTERVAL_MS = 10_000; // 10 seconds

type TelemetryDiagnostic = {
  name: string;
  data: unknown;
  timestamp: number;
};

type TelemetryReport = {
  sessionId: string;
  timestamp: number;
  sdkVersion: string;
  /** Tags that the backend should attach to every Datadog metric/log from this report. */
  tags: Record<string, string>;
  stats: WebRTCStats[];
  diagnostics: TelemetryDiagnostic[];
};

export interface TelemetryReporterOptions {
  telemetryUrl: string;
  apiKey: string;
  sessionId: string;
  integration?: string;
  logger: Logger;
  reportIntervalMs?: number;
}

/** Interface for telemetry reporting. Allows substituting a no-op implementation. */
export interface ITelemetryReporter {
  start(): void;
  addStats(stats: WebRTCStats): void;
  addDiagnostic(event: TelemetryDiagnostic): void;
  flush(): void;
  stop(): void;
}

/** No-op reporter that silently discards all data. Used when telemetry is disabled. */
export class NullTelemetryReporter implements ITelemetryReporter {
  start(): void {}
  addStats(): void {}
  addDiagnostic(): void {}
  flush(): void {}
  stop(): void {}
}

export class TelemetryReporter implements ITelemetryReporter {
  private telemetryUrl: string;
  private apiKey: string;
  private sessionId: string;
  private integration?: string;
  private logger: Logger;
  private reportIntervalMs: number;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private statsBuffer: WebRTCStats[] = [];
  private diagnosticsBuffer: TelemetryDiagnostic[] = [];

  constructor(options: TelemetryReporterOptions) {
    this.telemetryUrl = options.telemetryUrl;
    this.apiKey = options.apiKey;
    this.sessionId = options.sessionId;
    this.integration = options.integration;
    this.logger = options.logger;
    this.reportIntervalMs = options.reportIntervalMs ?? DEFAULT_REPORT_INTERVAL_MS;
  }

  /** Start the periodic reporting timer. */
  start(): void {
    if (this.intervalId !== null) return;
    this.intervalId = setInterval(() => this.flush(), this.reportIntervalMs);
  }

  /** Add a stats snapshot to the buffer. */
  addStats(stats: WebRTCStats): void {
    this.statsBuffer.push(stats);
  }

  /** Add a diagnostic event to the buffer. */
  addDiagnostic(event: TelemetryDiagnostic): void {
    this.diagnosticsBuffer.push(event);
  }

  /** Flush buffered data immediately. */
  flush(): void {
    this.sendReport(false);
  }

  /** Stop the reporter and send a final report with keepalive. */
  stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.sendReport(true);
  }

  private sendReport(keepalive: boolean): void {
    if (this.statsBuffer.length === 0 && this.diagnosticsBuffer.length === 0) {
      return;
    }

    const report: TelemetryReport = {
      sessionId: this.sessionId,
      timestamp: Date.now(),
      sdkVersion: VERSION,
      tags: {
        session_id: this.sessionId,
        sdk_version: VERSION,
        ...(this.integration ? { integration: this.integration } : {}),
      },
      stats: this.statsBuffer.splice(0),
      diagnostics: this.diagnosticsBuffer.splice(0),
    };

    try {
      const headers = buildAuthHeaders({ apiKey: this.apiKey, integration: this.integration });

      fetch(`${this.telemetryUrl}/v1/telemetry`, {
        method: "POST",
        headers: {
          ...headers,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(report),
        keepalive,
      }).catch((error) => {
        this.logger.debug("Telemetry report failed", { error: String(error) });
      });
    } catch (error) {
      this.logger.debug("Telemetry report failed", { error: String(error) });
    }
  }
}
