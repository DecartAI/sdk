import type { PixelLatencyStamper } from "./pixel-latency-stamper";

export type PixelLatencyMeasurement = {
  seq: number;
  e2eLatencyMs: number;
  timestamp: number;
};

export type PixelLatencyStats = {
  sent: number;
  received: number;
  lost: number;
  corrupted: number;
  outOfOrder: number;
  deliveryRate: number;
};

export type PixelLatencyStatus = "ok" | "ok_reordered" | "corrupted" | "lost";

export type PixelLatencyEvent =
  | { status: "ok"; seq: number; e2eLatencyMs: number; timestamp: number }
  | { status: "ok_reordered"; seq: number; e2eLatencyMs: number; timestamp: number }
  | { status: "corrupted"; seq: null; e2eLatencyMs: null; timestamp: number }
  | { status: "lost"; seq: number; e2eLatencyMs: null; timestamp: number; timeoutMs: number };

export type PixelLatencyReport = PixelLatencyStats & {
  timestamp: number;
  pending: number;
};

/** Message sent to server for legacy WS-probe mode. */
type LatencyProbeMessage = {
  type: "latency_probe";
  seq: number;
  client_time: number;
};

/** Periodic E2E stats report sent to server. */
type E2ELatencyReportMessage = {
  type: "e2e_latency_report";
  avg_latency_ms: number | null;
  delivery_rate: number;
  lost: number;
  corrupted: number;
  out_of_order: number;
};

export class PixelLatencyProbe {
  private static readonly SYNC = [200, 50, 200, 50];
  private static readonly DATA_BITS = 16;
  private static readonly CHECKSUM_BITS = 4;
  private static readonly TOTAL_PIXELS = 24;
  private static readonly MARKER_ROWS = 4;
  private static readonly DEFAULT_PROBE_INTERVAL_MS = 2000;
  private static readonly PROBE_TTL_MS = 60000;
  private static readonly REPORT_INTERVAL_MS = 5000;
  private static readonly CLEANUP_INTERVAL_MS = 5000;

  private seq = 0;
  private pendingProbes = new Map<number, number>(); // seq -> clientTime
  private canvas: OffscreenCanvas;
  private ctx: OffscreenCanvasRenderingContext2D;
  private probeIntervalId: ReturnType<typeof setInterval> | null = null;
  private reportIntervalId: ReturnType<typeof setInterval> | null = null;
  private cleanupIntervalId: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly probeIntervalMs: number;

  // E2E stamper (null = legacy WS-probe mode)
  private stamper: PixelLatencyStamper | null;

  // Stats tracking
  private lastReceivedSeq = 0;
  private recentLatencies: number[] = [];
  private stats = { sent: 0, received: 0, lost: 0, corrupted: 0, outOfOrder: 0 };
  // Previous snapshot for computing deltas sent to server
  private prevReportStats = { lost: 0, corrupted: 0, outOfOrder: 0 };

  private sendMessage: ((msg: LatencyProbeMessage | E2ELatencyReportMessage) => void) | null;
  private onMeasurement: (m: PixelLatencyMeasurement) => void;
  private onEvent: (e: PixelLatencyEvent) => void;
  private onReport: (r: PixelLatencyReport) => void;

  constructor(options: {
    sendMessage: ((msg: LatencyProbeMessage | E2ELatencyReportMessage) => void) | null;
    onMeasurement: (m: PixelLatencyMeasurement) => void;
    onEvent: (e: PixelLatencyEvent) => void;
    onReport: (r: PixelLatencyReport) => void;
    stamper?: PixelLatencyStamper;
    probeIntervalMs?: number;
  }) {
    this.probeIntervalMs = options.probeIntervalMs ?? PixelLatencyProbe.DEFAULT_PROBE_INTERVAL_MS;
    this.sendMessage = options.sendMessage;
    this.onMeasurement = options.onMeasurement;
    this.onEvent = options.onEvent;
    this.onReport = options.onReport;
    this.stamper = options.stamper ?? null;
    this.canvas = new OffscreenCanvas(PixelLatencyProbe.TOTAL_PIXELS, PixelLatencyProbe.MARKER_ROWS);
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("Failed to create OffscreenCanvas 2d context");
    this.ctx = ctx;
  }

  start(videoElement: HTMLVideoElement): void {
    if (this.running) return;
    this.running = true;

    if (this.stamper) {
      if (this.probeIntervalMs === 0) {
        // Every-frame mode: stamper calls us on each frame
        this.stamper.enableAutoStamp(() => {
          this.seq = (this.seq + 1) & 0xffff;
          this.pendingProbes.set(this.seq, performance.now());
          this.stats.sent++;
          return this.seq;
        });
      } else {
        // Interval mode: stamp input frames at configured interval
        this.probeIntervalId = setInterval(() => this.stampInputFrame(), this.probeIntervalMs);
      }
      // Periodic report (to server and/or local callback)
      this.reportIntervalId = setInterval(() => this.sendE2EReport(), PixelLatencyProbe.REPORT_INTERVAL_MS);
    } else if (this.sendMessage) {
      // Legacy WS-probe mode
      const interval = this.probeIntervalMs || PixelLatencyProbe.DEFAULT_PROBE_INTERVAL_MS;
      this.probeIntervalId = setInterval(() => this.sendProbe(), interval);
    }

    // Separate cleanup timer (decoupled from stamping)
    this.cleanupIntervalId = setInterval(() => this.cleanUpOldProbes(), PixelLatencyProbe.CLEANUP_INTERVAL_MS);

    // Read output frames
    this.readFrameLoop(videoElement);
  }

  stop(): void {
    this.running = false;
    if (this.probeIntervalId != null) {
      clearInterval(this.probeIntervalId);
      this.probeIntervalId = null;
    }
    if (this.reportIntervalId != null) {
      clearInterval(this.reportIntervalId);
      this.reportIntervalId = null;
    }
    if (this.cleanupIntervalId != null) {
      clearInterval(this.cleanupIntervalId);
      this.cleanupIntervalId = null;
    }
    this.stamper?.disableAutoStamp();
    this.pendingProbes.clear();
  }

  getStats(): PixelLatencyStats {
    const sent = this.stats.sent;
    return {
      ...this.stats,
      deliveryRate: sent > 0 ? this.stats.received / sent : 0,
    };
  }

  // ── E2E mode: stamp input frames ────────────────────────────────────

  private stampInputFrame(): void {
    if (!this.stamper) return;
    this.seq = (this.seq + 1) & 0xffff;
    const seq = this.seq;
    this.pendingProbes.set(seq, performance.now());
    this.stats.sent++;
    this.stamper.queueStamp(seq);
  }

  private sendE2EReport(): void {
    this.cleanUpOldProbes();
    this.onReport({ ...this.getStats(), timestamp: Date.now(), pending: this.pendingProbes.size });
    if (!this.sendMessage) return;
    const avgMs =
      this.recentLatencies.length > 0
        ? this.recentLatencies.reduce((a, b) => a + b, 0) / this.recentLatencies.length
        : null;
    const sent = this.stats.sent;
    const deltaLost = this.stats.lost - this.prevReportStats.lost;
    const deltaCorrupted = this.stats.corrupted - this.prevReportStats.corrupted;
    const deltaOutOfOrder = this.stats.outOfOrder - this.prevReportStats.outOfOrder;
    this.sendMessage({
      type: "e2e_latency_report",
      avg_latency_ms: avgMs !== null ? Math.round(avgMs * 100) / 100 : null,
      delivery_rate: sent > 0 ? this.stats.received / sent : 0,
      lost: deltaLost,
      corrupted: deltaCorrupted,
      out_of_order: deltaOutOfOrder,
    });
    this.prevReportStats = {
      lost: this.stats.lost,
      corrupted: this.stats.corrupted,
      outOfOrder: this.stats.outOfOrder,
    };
    this.recentLatencies = [];
  }

  // ── Legacy WS-probe mode ────────────────────────────────────────────

  private sendProbe(): void {
    if (!this.sendMessage) return;
    this.seq = (this.seq + 1) & 0xffff;
    const seq = this.seq;
    const clientTime = performance.now();
    this.pendingProbes.set(seq, clientTime);
    this.stats.sent++;
    this.sendMessage({ type: "latency_probe", seq, client_time: clientTime });
  }

  // ── Output frame reader (shared by both modes) ─────────────────────

  private readFrameLoop(video: HTMLVideoElement): void {
    if (!this.running) return;

    // Use requestVideoFrameCallback if available (Chrome/Edge), else requestAnimationFrame
    if ("requestVideoFrameCallback" in video) {
      // biome-ignore lint/suspicious/noExplicitAny: requestVideoFrameCallback not in all TS libs
      (video as any).requestVideoFrameCallback((_now: number, _metadata: unknown) => {
        this.readFrame(video);
        this.readFrameLoop(video);
      });
    } else {
      requestAnimationFrame(() => {
        this.readFrame(video);
        this.readFrameLoop(video);
      });
    }
  }

  private readFrame(video: HTMLVideoElement): void {
    if (video.videoWidth === 0 || video.videoHeight === 0) return;

    try {
      // Draw only the bottom-left 24x1 region
      this.ctx.drawImage(
        video,
        0,
        video.videoHeight - PixelLatencyProbe.MARKER_ROWS, // source x, y
        PixelLatencyProbe.TOTAL_PIXELS,
        PixelLatencyProbe.MARKER_ROWS, // source width, height
        0,
        0, // dest x, y
        PixelLatencyProbe.TOTAL_PIXELS,
        PixelLatencyProbe.MARKER_ROWS, // dest width, height
      );

      const imageData = this.ctx.getImageData(
        0,
        0,
        PixelLatencyProbe.TOTAL_PIXELS,
        PixelLatencyProbe.MARKER_ROWS,
      );
      const pixels = imageData.data; // RGBA, 4 bytes per pixel

      const result = this.extractSeq(pixels);
      if (result === "no_marker") return;
      if (result === "corrupted") {
        this.stats.corrupted++;
        this.onEvent({ status: "corrupted", seq: null, e2eLatencyMs: null, timestamp: Date.now() });
        return;
      }

      const seq = result;
      const clientTime = this.pendingProbes.get(seq);
      if (clientTime == null) return;

      this.pendingProbes.delete(seq);
      this.stats.received++;

      const e2eLatencyMs = performance.now() - clientTime;
      this.recentLatencies.push(e2eLatencyMs);
      const timestamp = Date.now();

      // Reorder detection
      let reordered = false;
      if (seq < this.lastReceivedSeq) {
        const distance = this.lastReceivedSeq - seq;
        if (distance < 0x8000) {
          this.stats.outOfOrder++;
          reordered = true;
        }
      }
      this.lastReceivedSeq = seq;

      this.onMeasurement({ seq, e2eLatencyMs, timestamp });
      this.onEvent({
        status: reordered ? "ok_reordered" : "ok",
        seq,
        e2eLatencyMs,
        timestamp,
      });
    } catch {
      // Ignore read errors (cross-origin, etc.)
    }
  }

  /**
   * Extract seq from pixel data.
   * Returns: number (valid seq), "no_marker" (sync doesn't match), "corrupted" (sync ok, checksum bad)
   */
  private extractSeq(pixels: Uint8ClampedArray): number | "no_marker" | "corrupted" {
    const tp = PixelLatencyProbe.TOTAL_PIXELS;
    const mr = PixelLatencyProbe.MARKER_ROWS;
    const rowStride = tp * 4; // bytes per row in RGBA

    // Collect row indices that pass sync check
    const validRowOffsets: number[] = [];
    for (let row = 0; row < mr; row++) {
      const rowOffset = row * rowStride;
      let syncOk = true;
      for (let i = 0; i < PixelLatencyProbe.SYNC.length; i++) {
        const r = pixels[rowOffset + i * 4]; // R channel
        const expected = PixelLatencyProbe.SYNC[i];
        if ((r >= 128) !== (expected >= 128)) {
          syncOk = false;
          break;
        }
      }
      if (syncOk) validRowOffsets.push(rowOffset);
    }

    if (validRowOffsets.length === 0) return "no_marker";

    const n = validRowOffsets.length;
    const threshold = n / 2; // strict majority

    // Per-bit majority vote for 16-bit seq
    let seq = 0;
    for (let i = 0; i < PixelLatencyProbe.DATA_BITS; i++) {
      let votes = 0;
      for (const rowOffset of validRowOffsets) {
        if (pixels[rowOffset + (4 + i) * 4] >= 128) votes++;
      }
      if (votes > threshold) {
        seq |= 1 << (PixelLatencyProbe.DATA_BITS - 1 - i);
      }
    }

    // Compute expected checksum
    let expectedChecksum = 0;
    for (let i = 0; i < PixelLatencyProbe.DATA_BITS; i += 4) {
      expectedChecksum ^= (seq >> i) & 0xf;
    }

    // Per-bit majority vote for 4-bit checksum
    let actualChecksum = 0;
    for (let i = 0; i < PixelLatencyProbe.CHECKSUM_BITS; i++) {
      let votes = 0;
      for (const rowOffset of validRowOffsets) {
        if (pixels[rowOffset + (20 + i) * 4] >= 128) votes++;
      }
      if (votes > threshold) {
        actualChecksum |= 1 << (PixelLatencyProbe.CHECKSUM_BITS - 1 - i);
      }
    }

    if (expectedChecksum !== actualChecksum) return "corrupted";

    return seq;
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  private cleanUpOldProbes(): void {
    const now = performance.now();
    for (const [s, t] of this.pendingProbes) {
      if (now - t > PixelLatencyProbe.PROBE_TTL_MS) {
        this.pendingProbes.delete(s);
        this.stats.lost++;
        this.onEvent({
          status: "lost",
          seq: s,
          e2eLatencyMs: null,
          timestamp: Date.now(),
          timeoutMs: PixelLatencyProbe.PROBE_TTL_MS,
        });
      }
    }
  }
}
