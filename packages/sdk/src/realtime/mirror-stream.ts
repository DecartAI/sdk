// Not in lib.dom yet.
interface MediaStreamTrackProcessorCtor {
  new (init: { track: MediaStreamTrack }): { readable: ReadableStream<VideoFrame> };
}
interface MediaStreamTrackGeneratorCtor {
  new (init: { kind: "video" }): MediaStreamTrack & { writable: WritableStream<VideoFrame> };
}

type FlipImpl = "track-processor" | "canvas" | "noop";

export interface MirroredStreamOptions {
  fps: number;
}

export interface MirroredStream {
  stream: MediaStream;
  dispose: () => void;
  impl: FlipImpl;
}

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

export function createMirroredStream(input: MediaStream, opts: MirroredStreamOptions): MirroredStream {
  const [sourceVideo] = input.getVideoTracks();
  const audioTracks = input.getAudioTracks();

  if (!sourceVideo) {
    return { stream: input, dispose: () => {}, impl: "noop" };
  }

  if (isMediaStreamTrackProcessorSupported()) {
    return createWithTrackProcessor(sourceVideo, audioTracks);
  }
  return createWithCanvas(sourceVideo, audioTracks, opts.fps);
}

function createWithTrackProcessor(sourceVideo: MediaStreamTrack, audioTracks: MediaStreamTrack[]): MirroredStream {
  const Processor = (globalThis as unknown as { MediaStreamTrackProcessor: MediaStreamTrackProcessorCtor })
    .MediaStreamTrackProcessor;
  const Generator = (globalThis as unknown as { MediaStreamTrackGenerator: MediaStreamTrackGeneratorCtor })
    .MediaStreamTrackGenerator;

  // Probe 2D context at setup so we fail loud here rather than silently
  // passing un-flipped frames through the pipeline.
  if (!new OffscreenCanvas(1, 1).getContext("2d")) {
    throw new Error("createMirroredStream: OffscreenCanvas 2D context unavailable");
  }

  const processor = new Processor({ track: sourceVideo });
  const generator = new Generator({ kind: "video" });

  let canvas = new OffscreenCanvas(1, 1);
  let ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;

  const transform = new TransformStream<VideoFrame, VideoFrame>({
    transform(frame, controller) {
      const w = frame.displayWidth;
      const h = frame.displayHeight;
      if (canvas.width !== w || canvas.height !== h) {
        canvas = new OffscreenCanvas(w, h);
        ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
      }

      // VideoFrames hold GPU buffers; close them deterministically even if
      // VideoFrame construction or enqueue throws.
      let flipped: VideoFrame | undefined;
      try {
        ctx.save();
        ctx.setTransform(-1, 0, 0, 1, w, 0);
        ctx.drawImage(frame, 0, 0, w, h);
        ctx.restore();
        flipped = new VideoFrame(canvas, { timestamp: frame.timestamp, alpha: "discard" });
        controller.enqueue(flipped);
        flipped = undefined;
      } finally {
        flipped?.close();
        frame.close();
      }
    },
  });

  processor.readable
    .pipeThrough(transform)
    .pipeTo(generator.writable)
    .catch(() => {});

  const stream = new MediaStream([generator, ...audioTracks]);

  let disposed = false;
  return {
    stream,
    impl: "track-processor",
    dispose: () => {
      if (disposed) return;
      disposed = true;
      generator.stop();
    },
  };
}

function createWithCanvas(sourceVideo: MediaStreamTrack, audioTracks: MediaStreamTrack[], fps: number): MirroredStream {
  if (typeof document === "undefined") {
    throw new Error("createMirroredStream requires a DOM environment (document is undefined)");
  }

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("createMirroredStream: 2D canvas context unavailable");
  }

  // Resolve the output track before kicking off playback / rAF, so a missing
  // captureStream API doesn't leave background work running.
  if (typeof canvas.captureStream !== "function") {
    throw new Error("createMirroredStream: canvas.captureStream unavailable");
  }
  const [flippedTrack] = canvas.captureStream(fps).getVideoTracks();
  if (!flippedTrack) {
    throw new Error("createMirroredStream: canvas.captureStream produced no video track");
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
      ctx.save();
      ctx.setTransform(-1, 0, 0, 1, w, 0);
      ctx.drawImage(video, 0, 0, w, h);
      ctx.restore();
    }
    rafHandle = requestAnimationFrame(draw);
  };

  void video.play().catch(() => {});
  rafHandle = requestAnimationFrame(draw);

  return {
    stream: new MediaStream([flippedTrack, ...audioTracks]),
    impl: "canvas",
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (rafHandle !== null) cancelAnimationFrame(rafHandle);
      flippedTrack.stop();
      video.srcObject = null;
    },
  };
}
