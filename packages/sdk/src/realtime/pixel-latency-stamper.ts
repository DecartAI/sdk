/**
 * Input frame stamper for E2E pixel latency.
 *
 * Wraps a camera MediaStreamTrack to optionally stamp a pixel marker (~every 2s).
 *
 * Primary path: Insertable Streams (MediaStreamTrackProcessor/Generator, Chrome 94+).
 *   - 1-in-1-out: output FPS naturally matches source (no rAF inflation).
 *   - 99% of frames pass through unchanged (zero copy, zero quality loss).
 *   - Only stamped frames go through OffscreenCanvas.
 *
 * Fallback: Canvas + rAF + captureStream (for environments without Insertable Streams).
 *
 * The marker is stamped across MARKER_ROWS bottom rows for codec resilience.
 */

const SYNC = [200, 50, 200, 50];
const DATA_BITS = 16;
const CHECKSUM_BITS = 4;
const TOTAL_PIXELS = 24; // 4 sync + 16 data + 4 checksum
const MARKER_ROWS = 4; // Redundant rows for codec resilience

export class PixelLatencyStamper {
  private originalTrack: MediaStreamTrack;
  private processedStream: MediaStream;
  private running = false;
  private pendingStamp: number | null = null;

  // Insertable Streams path
  private abortController: AbortController | null = null;

  // Canvas fallback path
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private sourceVideo: HTMLVideoElement | null = null;

  constructor(sourceVideoTrack: MediaStreamTrack) {
    this.originalTrack = sourceVideoTrack;

    if (typeof MediaStreamTrackProcessor !== "undefined") {
      this.processedStream = this.initInsertableStreams(sourceVideoTrack);
    } else {
      this.processedStream = this.initCanvasFallback(sourceVideoTrack);
    }
  }

  // ── Insertable Streams (primary) ─────────────────────────────────────

  private initInsertableStreams(track: MediaStreamTrack): MediaStream {
    const processor = new MediaStreamTrackProcessor({ track });
    const generator = new MediaStreamTrackGenerator({ kind: "video" });

    const stamper = this;
    const transformer = new TransformStream<VideoFrame, VideoFrame>({
      transform(frame, controller) {
        if (stamper.pendingStamp !== null) {
          const seq = stamper.pendingStamp;
          stamper.pendingStamp = null;

          const w = frame.displayWidth;
          const h = frame.displayHeight;
          const canvas = new OffscreenCanvas(w, h);
          const ctx = canvas.getContext("2d")!;
          ctx.drawImage(frame, 0, 0);
          stamper.stampMarker(ctx, h, seq);

          const stamped = new VideoFrame(canvas, { timestamp: frame.timestamp });
          frame.close();
          controller.enqueue(stamped);
        } else {
          // Pass through unchanged — zero copy, zero quality loss
          controller.enqueue(frame);
        }
      },
    });

    this.abortController = new AbortController();
    processor.readable
      .pipeThrough(transformer, { signal: this.abortController.signal })
      .pipeTo(generator.writable, { signal: this.abortController.signal })
      .catch(() => {
        // Expected on abort during stop()
      });

    return new MediaStream([generator]);
  }

  // ── Canvas fallback ──────────────────────────────────────────────────

  private initCanvasFallback(sourceVideoTrack: MediaStreamTrack): MediaStream {
    this.sourceVideo = document.createElement("video");
    this.sourceVideo.srcObject = new MediaStream([sourceVideoTrack]);
    this.sourceVideo.muted = true;
    this.sourceVideo.playsInline = true;

    this.canvas = document.createElement("canvas");

    const settings = sourceVideoTrack.getSettings();
    if (settings.width) this.canvas.width = settings.width;
    if (settings.height) this.canvas.height = settings.height;

    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("Failed to create canvas 2d context for pixel stamper");
    this.ctx = ctx;

    return this.canvas.captureStream();
  }

  // ── Public API ───────────────────────────────────────────────────────

  /** Get the processed MediaStream. */
  getProcessedStream(): MediaStream {
    return this.processedStream;
  }

  /** Get the original source track (for cleanup). */
  getOriginalTrack(): MediaStreamTrack {
    return this.originalTrack;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Canvas fallback needs explicit play + draw loop
    if (this.sourceVideo) {
      await this.sourceVideo.play();
      this.drawLoop();
    }
    // Insertable Streams path is already piping from the constructor
  }

  stop(): void {
    this.running = false;

    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }

    if (this.sourceVideo) {
      this.sourceVideo.pause();
      this.sourceVideo.srcObject = null;
    }

    for (const track of this.processedStream.getTracks()) {
      track.stop();
    }
  }

  /** Queue a marker seq to be stamped on the next frame. */
  queueStamp(seq: number): void {
    this.pendingStamp = seq;
  }

  // ── Canvas fallback draw loop ────────────────────────────────────────

  private drawLoop(): void {
    if (!this.running) return;

    requestAnimationFrame(() => {
      if (
        this.sourceVideo &&
        this.ctx &&
        this.canvas &&
        this.sourceVideo.videoWidth > 0 &&
        this.sourceVideo.videoHeight > 0
      ) {
        if (this.canvas.width !== this.sourceVideo.videoWidth) {
          this.canvas.width = this.sourceVideo.videoWidth;
        }
        if (this.canvas.height !== this.sourceVideo.videoHeight) {
          this.canvas.height = this.sourceVideo.videoHeight;
        }

        this.ctx.drawImage(this.sourceVideo, 0, 0);

        const seq = this.pendingStamp;
        if (seq !== null) {
          this.pendingStamp = null;
          this.stampMarker(this.ctx, this.canvas.height, seq);
        }
      }

      this.drawLoop();
    });
  }

  // ── Shared stamp logic ───────────────────────────────────────────────

  private stampMarker(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    canvasHeight: number,
    seq: number,
  ): void {
    const seqMasked = seq & 0xffff;
    const imageData = ctx.createImageData(TOTAL_PIXELS, MARKER_ROWS);
    const data = imageData.data;
    const rowStride = TOTAL_PIXELS * 4;

    for (let row = 0; row < MARKER_ROWS; row++) {
      const rowOffset = row * rowStride;

      // Sync pattern: R=G=B=200 or R=G=B=50
      for (let i = 0; i < 4; i++) {
        const val = SYNC[i];
        const offset = rowOffset + i * 4;
        data[offset] = val;
        data[offset + 1] = val;
        data[offset + 2] = val;
        data[offset + 3] = 255;
      }

      // 16-bit seq (MSB first)
      for (let i = 0; i < DATA_BITS; i++) {
        const bit = (seqMasked >> (DATA_BITS - 1 - i)) & 1;
        const val = bit ? 200 : 50;
        const offset = rowOffset + (4 + i) * 4;
        data[offset] = val;
        data[offset + 1] = val;
        data[offset + 2] = val;
        data[offset + 3] = 255;
      }

      // 4-bit XOR checksum
      let checksum = 0;
      for (let i = 0; i < DATA_BITS; i += 4) {
        checksum ^= (seqMasked >> i) & 0xf;
      }
      for (let i = 0; i < CHECKSUM_BITS; i++) {
        const bit = (checksum >> (CHECKSUM_BITS - 1 - i)) & 1;
        const val = bit ? 200 : 50;
        const offset = rowOffset + (20 + i) * 4;
        data[offset] = val;
        data[offset + 1] = val;
        data[offset + 2] = val;
        data[offset + 3] = 255;
      }
    }

    ctx.putImageData(imageData, 0, canvasHeight - MARKER_ROWS);
  }
}
