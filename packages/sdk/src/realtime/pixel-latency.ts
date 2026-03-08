import type { LatencyProbeMessage } from "./types";

export type PixelLatencyMeasurement = {
  seq: number;
  e2eLatencyMs: number;
  timestamp: number;
};

export class PixelLatencyProbe {
  private static readonly SYNC = [200, 50, 200, 50];
  private static readonly DATA_BITS = 16;
  private static readonly CHECKSUM_BITS = 4;
  private static readonly TOTAL_PIXELS = 24;
  private static readonly PROBE_INTERVAL_MS = 2000;
  private static readonly PROBE_TTL_MS = 10000;

  private seq = 0;
  private pendingProbes = new Map<number, number>(); // seq -> clientTime
  private canvas: OffscreenCanvas;
  private ctx: OffscreenCanvasRenderingContext2D;
  private probeIntervalId: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private sendMessage: (msg: LatencyProbeMessage) => void,
    private onMeasurement: (m: PixelLatencyMeasurement) => void,
  ) {
    this.canvas = new OffscreenCanvas(PixelLatencyProbe.TOTAL_PIXELS, 1);
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("Failed to create OffscreenCanvas 2d context");
    this.ctx = ctx;
  }

  start(videoElement: HTMLVideoElement): void {
    if (this.running) return;
    this.running = true;

    // Send probes every 2s
    this.probeIntervalId = setInterval(() => this.sendProbe(), PixelLatencyProbe.PROBE_INTERVAL_MS);

    // Read frames
    this.readFrameLoop(videoElement);
  }

  stop(): void {
    this.running = false;
    if (this.probeIntervalId != null) {
      clearInterval(this.probeIntervalId);
      this.probeIntervalId = null;
    }
    this.pendingProbes.clear();
  }

  private sendProbe(): void {
    const seq = ++this.seq;
    const clientTime = performance.now();
    this.pendingProbes.set(seq, clientTime);
    this.sendMessage({ type: "latency_probe", seq, client_time: clientTime });

    // Clean up old probes
    const now = performance.now();
    for (const [s, t] of this.pendingProbes) {
      if (now - t > PixelLatencyProbe.PROBE_TTL_MS) {
        this.pendingProbes.delete(s);
      }
    }
  }

  private readFrameLoop(video: HTMLVideoElement): void {
    if (!this.running) return;

    // Use requestVideoFrameCallback if available (Chrome/Edge), else requestAnimationFrame
    if ("requestVideoFrameCallback" in video) {
      (video as any).requestVideoFrameCallback((_now: number, _metadata: any) => {
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

      const seq = this.extractSeq(pixels);
      if (seq === null) return;

      const clientTime = this.pendingProbes.get(seq);
      if (clientTime == null) return;

      this.pendingProbes.delete(seq);
      const e2eLatencyMs = performance.now() - clientTime;

      this.onMeasurement({
        seq,
        e2eLatencyMs,
        timestamp: Date.now(),
      });
    } catch {
      // Ignore read errors (cross-origin, etc.)
    }
  }

  private extractSeq(pixels: Uint8ClampedArray): number | null {
    // Check sync pattern (R channel of RGBA, since canvas gives us RGB)
    // The Y value from yuv420p gets decoded to approximately the same R value
    // We use a wide threshold: >= 128 = high, < 128 = low
    for (let i = 0; i < PixelLatencyProbe.SYNC.length; i++) {
      const r = pixels[i * 4]; // R channel
      const expected = PixelLatencyProbe.SYNC[i];
      const isHigh = r >= 128;
      const shouldBeHigh = expected >= 128;
      if (isHigh !== shouldBeHigh) return null;
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

    if (expectedChecksum !== actualChecksum) return null;

    return seq;
  }
}
