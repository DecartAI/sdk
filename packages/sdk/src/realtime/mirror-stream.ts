// Not in lib.dom yet.
interface MediaStreamTrackProcessorCtor {
  new (init: { track: MediaStreamTrack }): { readable: ReadableStream<VideoFrame> };
}
interface MediaStreamTrackGeneratorCtor {
  new (init: { kind: "video" }): MediaStreamTrack & { writable: WritableStream<VideoFrame> };
}

export type FramePumpImpl = "track-processor" | "canvas" | "noop";

/**
 * A per-frame canvas operation. Receives the pump's 2D context, the current
 * source frame (a `VideoFrame` on the Insertable-Streams path, an
 * `HTMLVideoElement` on the canvas-fallback path) and its dimensions. The
 * implementation owns the `drawImage` call (so it can transform during the draw,
 * e.g. flip) plus any overlay it wants to add.
 */
export type FrameTransform = (
  ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
  source: CanvasImageSource,
  width: number,
  height: number,
) => void;

export interface FramePump {
  /** The transformed stream to publish — video track plus any pass-through audio. */
  stream: MediaStream;
  dispose: () => void;
  impl: FramePumpImpl;
}

export interface FramePumpOptions {
  /** Publish frame rate; sets the canvas-fallback `captureStream` cadence. */
  fps: number;
  transform: FrameTransform;
}

export interface MirroredStreamOptions {
  fps: number;
}

/** A mirrored stream is just a frame-transform pump whose op is a horizontal flip. */
export type MirroredStream = FramePump;

export function isMediaStreamTrackProcessorSupported(): boolean {
  return (
    typeof globalThis !== "undefined" &&
    typeof (globalThis as { MediaStreamTrackProcessor?: unknown }).MediaStreamTrackProcessor === "function" &&
    typeof (globalThis as { MediaStreamTrackGenerator?: unknown }).MediaStreamTrackGenerator === "function"
  );
}

export function shouldMirrorTrack(track: MediaStreamTrack): boolean {
  if (track.kind !== "video") return false;
  let facingMode: string | undefined;
  try {
    facingMode = track.getSettings?.().facingMode;
  } catch {
    return false;
  }
  return facingMode === "user";
}

/**
 * Wrap `input`'s video track so each published frame passes through `transform`.
 * Uses Insertable Streams (frame-accurate) where supported, a canvas
 * `captureStream` pump otherwise. No-ops (returns `input` unchanged) when there
 * is no video track. Audio tracks pass through untouched.
 */
export function createFrameTransformPump(input: MediaStream, opts: FramePumpOptions): FramePump {
  const [sourceVideo] = input.getVideoTracks();
  const audioTracks = input.getAudioTracks();

  if (!sourceVideo) {
    return { stream: input, dispose: () => {}, impl: "noop" };
  }

  if (isMediaStreamTrackProcessorSupported()) {
    return createWithTrackProcessor(sourceVideo, audioTracks, opts.transform);
  }
  return createWithCanvas(sourceVideo, audioTracks, opts.fps, opts.transform);
}

export function createMirroredStream(input: MediaStream, opts: MirroredStreamOptions): MirroredStream {
  return createFrameTransformPump(input, {
    fps: opts.fps,
    transform: (ctx, source, w, h) => {
      ctx.save();
      ctx.setTransform(-1, 0, 0, 1, w, 0);
      ctx.drawImage(source, 0, 0, w, h);
      ctx.restore();
    },
  });
}

function createWithTrackProcessor(
  sourceVideo: MediaStreamTrack,
  audioTracks: MediaStreamTrack[],
  transform: FrameTransform,
): FramePump {
  const Processor = (globalThis as unknown as { MediaStreamTrackProcessor: MediaStreamTrackProcessorCtor })
    .MediaStreamTrackProcessor;
  const Generator = (globalThis as unknown as { MediaStreamTrackGenerator: MediaStreamTrackGeneratorCtor })
    .MediaStreamTrackGenerator;

  // Probe the 2D context at setup so we fail loud here rather than silently
  // passing unprocessed frames through the pipeline.
  if (!new OffscreenCanvas(1, 1).getContext("2d")) {
    throw new Error("createFrameTransformPump: OffscreenCanvas 2D context unavailable");
  }

  const processor = new Processor({ track: sourceVideo });
  const generator = new Generator({ kind: "video" });

  let canvas = new OffscreenCanvas(1, 1);
  let ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;

  const pipeline = new TransformStream<VideoFrame, VideoFrame>({
    transform(frame, controller) {
      const w = frame.displayWidth;
      const h = frame.displayHeight;
      if (canvas.width !== w || canvas.height !== h) {
        canvas = new OffscreenCanvas(w, h);
        ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
      }

      // VideoFrames hold GPU buffers; close them deterministically even if
      // VideoFrame construction or enqueue throws.
      let out: VideoFrame | undefined;
      try {
        transform(ctx, frame, w, h);
        out = new VideoFrame(canvas, { timestamp: frame.timestamp, alpha: "discard" });
        controller.enqueue(out);
        out = undefined;
      } finally {
        out?.close();
        frame.close();
      }
    },
  });

  processor.readable
    .pipeThrough(pipeline)
    .pipeTo(generator.writable)
    .catch(() => {});

  let disposed = false;
  return {
    stream: new MediaStream([generator, ...audioTracks]),
    impl: "track-processor",
    dispose: () => {
      if (disposed) return;
      disposed = true;
      generator.stop();
    },
  };
}

function createWithCanvas(
  sourceVideo: MediaStreamTrack,
  audioTracks: MediaStreamTrack[],
  fps: number,
  transform: FrameTransform,
): FramePump {
  if (typeof document === "undefined") {
    throw new Error("createFrameTransformPump requires a DOM environment (document is undefined)");
  }

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("createFrameTransformPump: 2D canvas context unavailable");
  }

  // Resolve the output track before kicking off playback / rAF, so a missing
  // captureStream API doesn't leave background work running.
  if (typeof canvas.captureStream !== "function") {
    throw new Error("createFrameTransformPump: canvas.captureStream unavailable");
  }
  const [outTrack] = canvas.captureStream(fps).getVideoTracks();
  if (!outTrack) {
    throw new Error("createFrameTransformPump: canvas.captureStream produced no video track");
  }

  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;
  video.srcObject = new MediaStream([sourceVideo]);

  let disposed = false;
  let rafHandle: number | null = null;

  const draw = () => {
    if (disposed) return;
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (w > 0 && h > 0) {
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      transform(ctx, video, w, h);
    }
    rafHandle = requestAnimationFrame(draw);
  };

  void video.play().catch(() => {});
  rafHandle = requestAnimationFrame(draw);

  return {
    stream: new MediaStream([outTrack, ...audioTracks]),
    impl: "canvas",
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (rafHandle !== null) cancelAnimationFrame(rafHandle);
      outTrack.stop();
      video.srcObject = null;
    },
  };
}
