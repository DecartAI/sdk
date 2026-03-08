import { type WebRTCStats, StatsParser, type StatsOptions } from "./webrtc-stats";

const DEFAULT_INTERVAL_MS = 1000;
const MIN_INTERVAL_MS = 500;

// Minimal interface for IVS streams that support requestRTCStats
interface StatsCapableStream {
  requestRTCStats?(): Promise<RTCStatsReport | undefined>;
}

export interface IVSStatsSource {
  getRemoteStreams(): StatsCapableStream[];
  getLocalStreams(): StatsCapableStream[];
}

export class IVSStatsCollector {
  private parser = new StatsParser();
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private source: IVSStatsSource | null = null;
  private onStats: ((stats: WebRTCStats) => void) | null = null;
  private intervalMs: number;

  constructor(options: StatsOptions = {}) {
    this.intervalMs = Math.max(options.intervalMs ?? DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS);
  }

  start(source: IVSStatsSource, onStats: (stats: WebRTCStats) => void): void {
    this.stop();
    this.source = source;
    this.onStats = onStats;
    this.parser.reset();
    this.intervalId = setInterval(() => this.collect(), this.intervalMs);
  }

  stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.source = null;
    this.onStats = null;
  }

  isRunning(): boolean {
    return this.intervalId !== null;
  }

  private async collect(): Promise<void> {
    if (!this.source || !this.onStats) return;

    try {
      // Get RTCStatsReport from remote streams (inbound video/audio)
      const remoteStreams = this.source.getRemoteStreams();
      // Get from local streams (outbound video) if available
      const localStreams = this.source.getLocalStreams();

      // Collect all stats reports
      const reports: RTCStatsReport[] = [];

      for (const stream of remoteStreams) {
        if (stream.requestRTCStats) {
          const report = await stream.requestRTCStats();
          if (report) reports.push(report);
        }
      }
      for (const stream of localStreams) {
        if (stream.requestRTCStats) {
          const report = await stream.requestRTCStats();
          if (report) reports.push(report);
        }
      }

      if (reports.length === 0) return;

      // Merge all reports into a single Map-like structure that StatsParser can consume
      // RTCStatsReport is a Map<string, object>, so we can merge them
      const merged = new Map<string, object>();
      for (const report of reports) {
        report.forEach((value, key) => {
          merged.set(key, value);
        });
      }

      // StatsParser.parse() expects RTCStatsReport which has a forEach method
      // Our merged Map satisfies this interface
      const stats = this.parser.parse(merged as unknown as RTCStatsReport);
      this.onStats(stats);
    } catch {
      // Stream might be closed; stop silently
      this.stop();
    }
  }
}
