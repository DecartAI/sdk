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
  private static readonly PROBE_INTERVAL_MS = 2000;
  private static readonly PROBE_TTL_MS = 60000;
  private static readonly REPORT_INTERVAL_MS = 5000;

  private seq = 0;
  private pendingProbes = new Map<number, number>(); // seq -> clientTime
  private canvas: OffscreenCanvas;
  private ctx: OffscreenCanvasRenderingContext2D;
  private probeIntervalId: ReturnType<typeof setInterval> | null = null;
  private reportIntervalId: ReturnType<typeof setInterval> | null = null;
  private running = false;

  // E2E stamper (null = legacy WS-probe mode)
  private stamper: PixelLatencyStamper | null;

  // Stats tracking
  private lastReceivedSeq = 0;
  private recentLatencies: number[] = [];
  private stats = { sent: 0, received: 0, lost: 0, corrupted: 0, outOfOrder: 0 };

  constructor(
    private sendMessage: ((msg: LatencyProbeMessage | E2ELatencyReportMessage) => void) | null,
    private onMeasurement: (m: PixelLatencyMeasurement) => void,
    stamper?: PixelLatencyStamper,
  ) {
    this.canvas = new OffscreenCanvas(PixelLatencyProbe.TOTAL_PIXELS, 1);
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("Failed to create OffscreenCanvas 2d context");
    this.ctx = ctx;
    this.stamper = stamper ?? null;
  }

  start(videoElement: HTMLVideoElement): void {
    if (this.running) return;
    this.running = true;

    if (this.stamper) {
      // E2E mode: stamp input frames every ~2s
      this.probeIntervalId = setInterval(() => this.stampInputFrame(), PixelLatencyProbe.PROBE_INTERVAL_MS);
      // Periodic report to server
      if (this.sendMessage) {
        this.reportIntervalId = setInterval(() => this.sendE2EReport(), PixelLatencyProbe.REPORT_INTERVAL_MS);
      }
    } else if (this.sendMessage) {
      // Legacy WS-probe mode
      this.probeIntervalId = setInterval(() => this.sendProbe(), PixelLatencyProbe.PROBE_INTERVAL_MS);
    }

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
    const seq = ++this.seq;
    this.pendingProbes.set(seq, performance.now());
    this.stats.sent++;
    this.stamper.queueStamp(seq);
    this.cleanUpOldProbes();
  }

  private sendE2EReport(): void {
    if (!this.sendMessage) return;
    const avgMs =
      this.recentLatencies.length > 0
        ? this.recentLatencies.reduce((a, b) => a + b, 0) / this.recentLatencies.length
        : null;
    const sent = this.stats.sent;
    this.sendMessage({
      type: "e2e_latency_report",
      avg_latency_ms: avgMs !== null ? Math.round(avgMs * 100) / 100 : null,
      delivery_rate: sent > 0 ? this.stats.received / sent : 0,
      lost: this.stats.lost,
      corrupted: this.stats.corrupted,
      out_of_order: this.stats.outOfOrder,
    });
    this.recentLatencies = [];
  }

  // ── Legacy WS-probe mode ────────────────────────────────────────────

  private sendProbe(): void {
    if (!this.sendMessage) return;
    const seq = ++this.seq;
    const clientTime = performance.now();
    this.pendingProbes.set(seq, clientTime);
    this.stats.sent++;
    this.sendMessage({ type: "latency_probe", seq, client_time: clientTime });
    this.cleanUpOldProbes();
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
        video.videoHeight - 1, // source x, y (bottom-left)
        PixelLatencyProbe.TOTAL_PIXELS,
        1, // source width, height
        0,
        0, // dest x, y
        PixelLatencyProbe.TOTAL_PIXELS,
        1, // dest width, height
      );

      const imageData = this.ctx.getImageData(0, 0, PixelLatencyProbe.TOTAL_PIXELS, 1);
      const pixels = imageData.data; // RGBA, 4 bytes per pixel

      const result = this.extractSeq(pixels);
      if (result === "no_marker") return;
      if (result === "corrupted") {
        this.stats.corrupted++;
        return;
      }

      const seq = result;
      const clientTime = this.pendingProbes.get(seq);
      if (clientTime == null) return;

      this.pendingProbes.delete(seq);
      this.stats.received++;

      // Reorder detection
      if (seq < this.lastReceivedSeq) {
        // Handle wrapping: only count as out-of-order if distance is small
        const distance = this.lastReceivedSeq - seq;
        if (distance < 0x8000) {
          this.stats.outOfOrder++;
        }
      }
      this.lastReceivedSeq = seq;

      const e2eLatencyMs = performance.now() - clientTime;
      this.recentLatencies.push(e2eLatencyMs);

      this.onMeasurement({
        seq,
        e2eLatencyMs,
        timestamp: Date.now(),
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
    // Check sync pattern (R channel of RGBA)
    for (let i = 0; i < PixelLatencyProbe.SYNC.length; i++) {
      const r = pixels[i * 4]; // R channel
      const expected = PixelLatencyProbe.SYNC[i];
      const isHigh = r >= 128;
      const shouldBeHigh = expected >= 128;
      if (isHigh !== shouldBeHigh) return "no_marker";
    }

    // Extract 16-bit seq
    let seq = 0;
    for (let i = 0; i < PixelLatencyProbe.DATA_BITS; i++) {
      const r = pixels[(4 + i) * 4];
      if (r >= 128) {
        seq |= 1 << (PixelLatencyProbe.DATA_BITS - 1 - i);
      }
    }

    // Verify 4-bit XOR checksum
    let expectedChecksum = 0;
    for (let i = 0; i < PixelLatencyProbe.DATA_BITS; i += 4) {
      expectedChecksum ^= (seq >> i) & 0xf;
    }

    let actualChecksum = 0;
    for (let i = 0; i < PixelLatencyProbe.CHECKSUM_BITS; i++) {
      const r = pixels[(20 + i) * 4];
      if (r >= 128) {
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
      }
    }
  }
}
