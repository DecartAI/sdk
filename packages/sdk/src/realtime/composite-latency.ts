import type { MetricsReportMessage } from "./types";

export type CompositeLatencyEstimate = {
  clientProxyRttMs: number;
  serverProxyRttMs: number;
  pipelineLatencyMs: number;
  compositeE2eMs: number;
};

export class CompositeLatencyTracker {
  private latestServerReport: {
    serverProxyRttMs: number;
    pipelineLatencyMs: number;
  } | null = null;

  onServerReport(msg: MetricsReportMessage): void {
    this.latestServerReport = {
      serverProxyRttMs: msg.rtt_ms ?? 0,
      pipelineLatencyMs: msg.pipeline_latency_ms ?? 0,
    };
  }

  /**
   * Compute composite E2E estimate.
   * @param clientRttSeconds - client RTT in seconds from WebRTC stats, or null if unavailable (IVS)
   */
  getEstimate(clientRttSeconds: number | null): CompositeLatencyEstimate | null {
    if (!this.latestServerReport) return null;

    const { serverProxyRttMs, pipelineLatencyMs } = this.latestServerReport;
    // Client RTT may be unavailable for IVS transport (no candidate-pair stats).
    // In that case, report lower-bound estimate with clientProxyRttMs = 0.
    const clientProxyRttMs = clientRttSeconds != null ? clientRttSeconds * 1000 : 0;
    const compositeE2eMs = clientProxyRttMs + serverProxyRttMs + pipelineLatencyMs;

    return {
      clientProxyRttMs,
      serverProxyRttMs,
      pipelineLatencyMs,
      compositeE2eMs,
    };
  }
}
