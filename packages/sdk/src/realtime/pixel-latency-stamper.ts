/**
 * Canvas-based input frame stamper for E2E pixel latency.
 *
 * Wraps a camera MediaStreamTrack with a canvas-processed track.
 * Uses requestAnimationFrame loop: draw camera → optionally stamp marker → captureStream().
 * The PixelLatencyProbe queues a seq to stamp every ~2s.
 */

const SYNC = [200, 50, 200, 50];
const DATA_BITS = 16;
const CHECKSUM_BITS = 4;
const TOTAL_PIXELS = 24; // 4 sync + 16 data + 4 checksum

export class PixelLatencyStamper {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private sourceVideo: HTMLVideoElement;
  private processedStream: MediaStream;
  private originalTrack: MediaStreamTrack;
  private running = false;
  private pendingStamp: number | null = null; // seq to stamp on next frame

  constructor(sourceVideoTrack: MediaStreamTrack) {
    this.originalTrack = sourceVideoTrack;

    // Hidden video element to render the source track
    this.sourceVideo = document.createElement("video");
    this.sourceVideo.srcObject = new MediaStream([sourceVideoTrack]);
    this.sourceVideo.muted = true;
    this.sourceVideo.playsInline = true;

    this.canvas = document.createElement("canvas");

    // Initialize canvas dimensions from track settings so it's not 300x150
    const settings = sourceVideoTrack.getSettings();
    if (settings.width) this.canvas.width = settings.width;
    if (settings.height) this.canvas.height = settings.height;

    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("Failed to create canvas 2d context for pixel stamper");
    this.ctx = ctx;

    // captureStream() with no args = frame rate matches requestAnimationFrame
    this.processedStream = this.canvas.captureStream();
  }

  /** Get the processed MediaStream (canvas video track). */
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
    await this.sourceVideo.play();
    this.drawLoop();
  }

  stop(): void {
    this.running = false;
    this.sourceVideo.pause();
    this.sourceVideo.srcObject = null;
    // Stop canvas tracks
    for (const track of this.processedStream.getTracks()) {
      track.stop();
    }
  }

  /** Queue a marker seq to be stamped on the next drawn frame. */
  queueStamp(seq: number): void {
    this.pendingStamp = seq;
  }

  private drawLoop(): void {
    if (!this.running) return;

    requestAnimationFrame(() => {
      if (this.sourceVideo.videoWidth > 0 && this.sourceVideo.videoHeight > 0) {
        // Resize canvas to match source if needed
        if (this.canvas.width !== this.sourceVideo.videoWidth) {
          this.canvas.width = this.sourceVideo.videoWidth;
        }
        if (this.canvas.height !== this.sourceVideo.videoHeight) {
          this.canvas.height = this.sourceVideo.videoHeight;
        }

        // Draw camera frame
        this.ctx.drawImage(this.sourceVideo, 0, 0);

        // Stamp marker if queued
        const seq = this.pendingStamp;
        if (seq !== null) {
          this.pendingStamp = null;
          this.stampMarker(seq);
        }
      }

      this.drawLoop();
    });
  }

  private stampMarker(seq: number): void {
    const seqMasked = seq & 0xffff;
    const imageData = this.ctx.createImageData(TOTAL_PIXELS, 1);
    const data = imageData.data;

    // Sync pattern: R=G=B=200 or R=G=B=50 (maps to Y=200/Y=50 in YUV)
    for (let i = 0; i < 4; i++) {
      const val = SYNC[i];
      const offset = i * 4;
      data[offset] = val; // R
      data[offset + 1] = val; // G
      data[offset + 2] = val; // B
      data[offset + 3] = 255; // A
    }

    // 16-bit seq (MSB first)
    for (let i = 0; i < DATA_BITS; i++) {
      const bit = (seqMasked >> (DATA_BITS - 1 - i)) & 1;
      const val = bit ? 200 : 50;
      const offset = (4 + i) * 4;
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
      const offset = (20 + i) * 4;
      data[offset] = val;
      data[offset + 1] = val;
      data[offset + 2] = val;
      data[offset + 3] = 255;
    }

    this.ctx.putImageData(imageData, 0, this.canvas.height - 1);
  }
}
