import { buildAuthHeaders } from "../../shared/request";
import type { Logger } from "../../utils/logger";
import { VERSION } from "../../version";
import { REALTIME_CONFIG } from "../config-realtime";
import type { WebRTCStats } from "./webrtc-stats";

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

const KEEPALIVE_MAX_BODY_BYTES = 60 * 1024;

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
  private reportIntervalMs: number;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private statsBuffer: WebRTCStats[] = [];
  private diagnosticsBuffer: TelemetryDiagnostic[] = [];

  constructor(options: TelemetryReporterOptions) {
    this.apiKey = options.apiKey;
    this.sessionId = options.sessionId;
    this.model = options.model;
    this.integration = options.integration;
    this.reportIntervalMs = options.reportIntervalMs ?? REALTIME_CONFIG.observability.telemetryReportIntervalMs;
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
    this.sendReport();
  }

  /** Stop the reporter and make one final best-effort flush. */
  stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.sendReport({ keepalive: true });
  }

  /**
   * Build a single chunk from the front of the buffers, respecting the configured report item cap.
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
      stats: this.statsBuffer.splice(0, REALTIME_CONFIG.observability.telemetryMaxItemsPerReport),
      diagnostics: this.diagnosticsBuffer.splice(0, REALTIME_CONFIG.observability.telemetryMaxItemsPerReport),
    };
  }

  private sendReport(options: { keepalive?: boolean } = {}): void {
    if (this.statsBuffer.length === 0 && this.diagnosticsBuffer.length === 0) {
      return;
    }

    try {
      const headers = buildAuthHeaders({ apiKey: this.apiKey, integration: this.integration });
      const commonHeaders = {
        ...headers,
        "Content-Type": "application/json",
      };

      const chunks: TelemetryReport[] = [];
      let nextChunk = this.createReportChunk();
      while (nextChunk !== null) {
        chunks.push(nextChunk);
        nextChunk = this.createReportChunk();
      }

      chunks.forEach((chunk, index) => {
        const body = JSON.stringify(chunk);
        const useKeepalive =
          options.keepalive &&
          index === chunks.length - 1 &&
          new TextEncoder().encode(body).byteLength <= KEEPALIVE_MAX_BODY_BYTES;

        fetch(REALTIME_CONFIG.observability.telemetryUrl, {
          method: "POST",
          headers: commonHeaders,
          body,
          ...(useKeepalive ? { keepalive: true } : {}),
        }).catch(() => {});
      });
    } catch {
      // Telemetry is best-effort and should never add console noise for SDK users.
    }
  }
}
