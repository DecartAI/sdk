export type G2GMetrics = {
  /** Time from connection start to the first rendered output frame. */
  ttffMs: number | null;
  /** Median steady-state camera-to-display latency. */
  medianMs: number | null;
  /** 90th percentile steady-state camera-to-display latency. */
  p90Ms: number | null;
  sampleCount: number;
  /** Recent stamped frames that never returned, from 0 to 1. */
  dropRatio: number | null;
};
