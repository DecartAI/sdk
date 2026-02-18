import { buildAuthHeaders } from "../shared/request";
import type { Logger } from "../utils/logger";
import { VERSION } from "../version";
import type { WebRTCStats } from "./webrtc-stats";

const DEFAULT_REPORT_INTERVAL_MS = 10_000; // 10 seconds
const TELEMETRY_URL = "https://platform.decart.ai/api/v1/telemetry";

/**
 * Maximum number of items per array (stats / diagnostics) in a single report.
 * Matches the backend Zod schema which enforces `z.array().max(120)`.
 */
const MAX_ITEMS_PER_REPORT = 120;

type TelemetryDiagnostic = {
  name: string;
  data: unknown;
  timestamp: number;
};

type TelemetryReport = {
  sessionId: string;
  timestamp: number;
  sdkVersion: string;
  model?: string;
  /** Tags that the backend should attach to every Datadog metric/log from this report. */
  tags: Record<string, string>;
  stats: WebRTCStats[];
  diagnostics: TelemetryDiagnostic[];
};

export interface TelemetryReporterOptions {
  apiKey: string;
  sessionId: string;
  model?: string;
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
  private apiKey: string;
  private sessionId: string;
  private model?: string;
  private integration?: string;
  private logger: Logger;
  private reportIntervalMs: number;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private statsBuffer: WebRTCStats[] = [];
  private diagnosticsBuffer: TelemetryDiagnostic[] = [];

  constructor(options: TelemetryReporterOptions) {
    this.apiKey = options.apiKey;
    this.sessionId = options.sessionId;
    this.model = options.model;
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

  /**
   * Build a single chunk from the front of the buffers, respecting MAX_ITEMS_PER_REPORT.
   * Returns null when both buffers are empty.
   */
  private createReportChunk(): TelemetryReport | null {
    if (this.statsBuffer.length === 0 && this.diagnosticsBuffer.length === 0) {
      return null;
    }

    const tags: Record<string, string> = {
      session_id: this.sessionId,
      sdk_version: VERSION,
      ...(this.model ? { model: this.model } : {}),
      ...(this.integration ? { integration: this.integration } : {}),
    };

    return {
      sessionId: this.sessionId,
      timestamp: Date.now(),
      sdkVersion: VERSION,
      ...(this.model ? { model: this.model } : {}),
      tags,
      stats: this.statsBuffer.splice(0, MAX_ITEMS_PER_REPORT),
      diagnostics: this.diagnosticsBuffer.splice(0, MAX_ITEMS_PER_REPORT),
    };
  }

  private sendReport(keepalive: boolean): void {
    if (this.statsBuffer.length === 0 && this.diagnosticsBuffer.length === 0) {
      return;
    }

    try {
      const headers = buildAuthHeaders({ apiKey: this.apiKey, integration: this.integration });
      const commonHeaders = {
        ...headers,
        "Content-Type": "application/json",
      };

      // Send as many chunks as needed to drain both buffers.
      let chunk = this.createReportChunk();
      while (chunk !== null) {
        const isLast = this.statsBuffer.length === 0 && this.diagnosticsBuffer.length === 0;

        fetch(TELEMETRY_URL, {
          method: "POST",
          headers: commonHeaders,
          body: JSON.stringify(chunk),
          // Only set keepalive on the very last chunk (if the caller requested it).
          keepalive: keepalive && isLast,
        })
          .then((response) => {
            if (!response.ok) {
              this.logger.warn("Telemetry report rejected", {
                status: response.status,
                statusText: response.statusText,
              });
            }
          })
          .catch((error) => {
            this.logger.debug("Telemetry report failed", { error: String(error) });
          });

        chunk = this.createReportChunk();
      }
    } catch (error) {
      this.logger.debug("Telemetry report failed", { error: String(error) });
    }
  }
}
