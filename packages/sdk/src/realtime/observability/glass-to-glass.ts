/**
 * True glass-to-glass latency measurement for the realtime pipeline.
 *
 * Opt-in (the marker is visible in the output and pixel work has a cost). When
 * enabled, the SDK stamps a monotonic sequence number into the bottom-left of
 * every outgoing frame ({@link createStampPump}) and reads it back off the
 * rendered remote frames ({@link createMarkerReader}); the server re-stamps the
 * seq from input to matching output (its `pixel_latency` mode). The
 * {@link SeqTracker} matches stamp time to render time to compute the real
 * camera→display latency through the model, and infers end-to-end frame drops
 * from seqs that are stamped but never rendered.
 *
 * The stamp pump is built on the shared `createFrameTransformPump` (Insertable
 * Streams where available, canvas `captureStream` fallback). The reader is a
 * passive offscreen-`<video>` tap so it never consumes or re-encodes the track
 * the consumer displays.
 */

import { createFrameTransformPump, type FramePump } from "../mirror-stream";
import {
  MAX_MARKER_HEIGHT,
  MIN_MARKER_HEIGHT,
  MIN_MARKER_WIDTH,
  type RGBAImageData,
  read,
  stamp,
} from "./pixel-marker";

/**
 * Aggregated glass-to-glass metrics. TTFF (startup) and mid-stream (steady
 * state) are measured separately — they differ by an order of magnitude and the
 * cold-start frames must not pollute the steady-state numbers.
 */
export type G2GMetrics = {
  /**
   * Time-to-first-frame (ms): from the connect attempt start to the first
   * rendered model output. A one-shot startup metric, ~seconds. Null until the
   * first frame arrives.
   */
  ttffMs: number | null;
  /**
   * Median mid-stream (steady-state) glass-to-glass latency (ms), excluding the
   * warm-up after the first frame. Null until past warm-up. This is the
   * per-frame responsiveness, distinct from `ttffMs`.
   */
  medianMs: number | null;
  /** p90 mid-stream glass-to-glass latency (ms), or null until past warm-up. */
  p90Ms: number | null;
  /** Mid-stream latency samples in the window (post-warm-up). */
  sampleCount: number;
  /**
   * End-to-end frame drop ratio (0–1): seqs stamped but never rendered, over
   * recent post-warm-up outcomes. Null until enough frames have completed the
   * round trip — short sessions/probes may never produce it.
   */
  dropRatio: number | null;
};

/** Bound on in-flight seqs; a seq that ages out unmatched is an end-to-end drop. Cf. server `_MAX_PENDING`. */
const MAX_PENDING = 256;
/** Rolling window for the latency percentiles (≈10s at 30fps). */
const LATENCY_WINDOW = 300;
/** Rolling window of delivered/dropped outcomes for the drop ratio. */
const OUTCOME_WINDOW = 300;
/** Don't report a drop ratio until this many outcomes exist (head-of-stream frames are still in flight). */
const DROP_MIN_OUTCOMES = 30;
/** Discard implausible deltas (clock weirdness, seq wrap collisions). */
const MAX_PLAUSIBLE_MS = 60_000;
/**
 * After the first frame, ignore this long before counting steady-state samples.
 * The first frames after a cold start run slow while the pipeline warms; folding
 * them into the mid-stream median would inflate it. (TTFF still captures the
 * first frame.)
 */
const MID_STREAM_WARMUP_MS = 2_000;

/**
 * Matches outgoing stamp times to incoming render times. Shared by the stamp
 * pump (writer) and the marker reader (matcher); owned by `RealtimeObservability`.
 *
 * Tracks two latencies: TTFF (start → first frame) and mid-stream median (steady
 * state, after a warm-up). Call `markStart()` at the beginning of each connect
 * attempt so TTFF measures the full setup→first-frame wait.
 */
export class SeqTracker {
  private readonly stampTimes = new Map<number, number>();
  private readonly latencies: number[] = [];
  /** true = delivered (matched), false = dropped (aged out unmatched). */
  private readonly outcomes: boolean[] = [];
  private nextSeq = 0;
  private startMs: number | null = null;
  private firstMatchMs: number | null = null;
  private ttffMs: number | null = null;

  /** Mark the start of a connect attempt; resets measurement state. TTFF is measured from here. */
  markStart(nowMs: number): void {
    this.reset();
    this.startMs = nowMs;
  }

  /** Allocate the next seq for an outgoing frame and record its stamp time. Returns the 16-bit seq. */
  stampNext(nowMs: number): number {
    const seq = this.nextSeq & 0xffff;
    this.nextSeq = (this.nextSeq + 1) & 0xffff;
    this.stampTimes.set(seq, nowMs);
    if (this.stampTimes.size > MAX_PENDING) {
      // Oldest insertion (Map preserves order) aged out without a match.
      const oldest = this.stampTimes.keys().next();
      if (!oldest.done) {
        this.stampTimes.delete(oldest.value);
        // Only a real drop once the stream is live and past warm-up; pre-publish
        // and cold-start stamps that age out are not counted.
        if (this.isPastWarmup(nowMs)) this.recordOutcome(false);
      }
    }
    return seq;
  }

  /** Match a seq read off an inbound rendered frame. Ignores unknown/duplicate seqs. */
  recordInbound(seq: number, nowMs: number): void {
    const stampedAt = this.stampTimes.get(seq);
    if (stampedAt === undefined) return; // unknown, already consumed, or evicted
    this.stampTimes.delete(seq);
    const g2g = nowMs - stampedAt;
    if (g2g < 0 || g2g > MAX_PLAUSIBLE_MS) return;

    if (this.firstMatchMs === null) {
      // First rendered frame: capture TTFF and discard any older (pre-publish /
      // pre-warm) pending stamps so they don't later age out as phantom drops.
      this.firstMatchMs = nowMs;
      if (this.startMs !== null) this.ttffMs = nowMs - this.startMs;
      for (const [key, stampTime] of this.stampTimes) {
        if (stampTime < stampedAt) this.stampTimes.delete(key);
        else break; // insertion order == time order
      }
    }

    if (!this.isPastWarmup(nowMs)) return; // first frame + warm-up don't pollute steady state
    this.latencies.push(g2g);
    if (this.latencies.length > LATENCY_WINDOW) this.latencies.shift();
    this.recordOutcome(true);
  }

  snapshot(): G2GMetrics {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const pct = (p: number): number | null =>
      sorted.length === 0 ? null : Math.round(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]);
    let dropRatio: number | null = null;
    if (this.outcomes.length >= DROP_MIN_OUTCOMES) {
      const dropped = this.outcomes.reduce((n, delivered) => n + (delivered ? 0 : 1), 0);
      dropRatio = dropped / this.outcomes.length;
    }
    return { ttffMs: this.ttffMs, medianMs: pct(0.5), p90Ms: pct(0.9), sampleCount: sorted.length, dropRatio };
  }

  /** Clear measurement state. Keeps `nextSeq` monotonic to avoid stale collisions. */
  reset(): void {
    this.stampTimes.clear();
    this.latencies.length = 0;
    this.outcomes.length = 0;
    this.startMs = null;
    this.firstMatchMs = null;
    this.ttffMs = null;
  }

  private isPastWarmup(nowMs: number): boolean {
    return this.firstMatchMs !== null && nowMs >= this.firstMatchMs + MID_STREAM_WARMUP_MS;
  }

  private recordOutcome(delivered: boolean): void {
    this.outcomes.push(delivered);
    if (this.outcomes.length > OUTCOME_WINDOW) this.outcomes.shift();
  }
}

export type StampPump = FramePump;

export interface StampPumpOptions {
  tracker: SeqTracker;
  /** Publish frame rate; sets the canvas-fallback capture + stamp cadence. */
  fps: number;
}

/**
 * Wrap `input` so every published video frame carries a fresh marker (drawn into
 * the bottom-left band). Built on the shared frame-transform pump; no-ops when
 * there's no video track or the frame is too small to hold the marker.
 */
export function createStampPump(input: MediaStream, opts: StampPumpOptions): StampPump {
  const { tracker, fps } = opts;
  const stampIntervalMs = 1000 / fps;
  let lastStampMs = 0;
  let currentSeq: number | null = null;

  return createFrameTransformPump(input, {
    fps,
    transform: (ctx, source, w, h) => {
      ctx.drawImage(source, 0, 0, w, h);
      if (w < MIN_MARKER_WIDTH || h < MIN_MARKER_HEIGHT) return;
      // Allocate a new seq at ~fps cadence and hold it across faster (rAF) draws:
      // captureStream only samples at fps, so minting a seq per draw would create
      // seqs that never get encoded (phantom drops). On the frame-accurate path
      // frames already arrive at ~fps, so this is effectively one seq per frame.
      const now = performance.now();
      if (currentSeq === null || now - lastStampMs >= stampIntervalMs - 1) {
        currentSeq = tracker.stampNext(now);
        lastStampMs = now;
      }
      const band = ctx.getImageData(0, h - MIN_MARKER_HEIGHT, w, MIN_MARKER_HEIGHT) as RGBAImageData;
      stamp(band, currentSeq);
      ctx.putImageData(band as unknown as ImageData, 0, h - MIN_MARKER_HEIGHT);
    },
  });
}

export interface MarkerReader {
  /** Attach (or replace) the remote video track to read markers from. */
  attach: (track: MediaStreamTrack) => void;
  dispose: () => void;
}

/**
 * Drives `onFrame` once per rendered video frame. Prefers
 * `requestVideoFrameCallback` (fires per decoded frame) over `requestAnimationFrame`
 * (fires at display refresh — ~2× the work on a 30fps stream shown at 60Hz).
 * The `typeof` guard keeps the rAF fallback for browsers that lack rVFC.
 */
function createFrameScheduler(video: HTMLVideoElement, onFrame: () => void): { start: () => void; stop: () => void } {
  const supportsRvfc = typeof video.requestVideoFrameCallback === "function";
  let handle: number | null = null;
  let running = false;

  const schedule = () => {
    if (!running) return; // never re-arm after stop(), even if a trailing tick calls us
    handle = supportsRvfc ? video.requestVideoFrameCallback(tick) : requestAnimationFrame(tick);
  };
  const tick = () => {
    if (!running) return;
    onFrame();
    schedule();
  };

  return {
    start: () => {
      if (running) return;
      running = true;
      schedule();
    },
    stop: () => {
      running = false;
      if (handle === null) return;
      if (supportsRvfc) video.cancelVideoFrameCallback(handle);
      else cancelAnimationFrame(handle);
      handle = null;
    },
  };
}

/**
 * Passively read markers off the rendered remote video. Uses a hidden `<video>`
 * fed by the same track (a track can drive multiple sinks), reading only the
 * bottom band per rendered frame — never consumes or re-encodes the displayed track.
 */
export function createMarkerReader(tracker: SeqTracker): MarkerReader {
  if (typeof document === "undefined") {
    // Non-DOM env: reading isn't possible; latency simply won't populate.
    return { attach: () => {}, dispose: () => {} };
  }

  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  let attachedTrack: MediaStreamTrack | null = null;

  const readFrame = () => {
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (w === 0 || h === 0 || !ctx) return;
    // The marker sits in the bottom rows; read only a band tall enough for it
    // at the largest auto-detected block size.
    const band = Math.min(h, MAX_MARKER_HEIGHT);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== band) canvas.height = band;
    ctx.drawImage(video, 0, h - band, w, band, 0, 0, w, band);
    const seq = read(ctx.getImageData(0, 0, w, band) as RGBAImageData);
    if (seq !== null) tracker.recordInbound(seq, performance.now());
  };

  const scheduler = createFrameScheduler(video, readFrame);

  return {
    attach: (track: MediaStreamTrack) => {
      if (track === attachedTrack) return;
      attachedTrack = track;
      video.srcObject = new MediaStream([track]);
      void video.play().catch(() => {});
      scheduler.start();
    },
    dispose: () => {
      scheduler.stop();
      attachedTrack = null;
      video.srcObject = null;
    },
  };
}
