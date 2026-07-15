import { isDesktopSafari } from "../../utils/platform";
import type { PrepareConnection } from "../client";
import { createLiveKitMediaChannel } from "../media-channel";
import { RealtimeObservability } from "../observability/realtime-observability";
import { createBrowserFrameMetadataDiagnostics, createFrameMetadataWorker } from "./frame-metadata-diagnostics";
import { createMirroredStream, shouldMirrorTrack } from "./mirror-stream";

export const prepareBrowserConnection: PrepareConnection = ({
  stream,
  mirror,
  debugQuality,
  preferredVideoCodec,
  fps,
  logger,
  observability: observabilityOptions,
}) => {
  let inputStream = stream ?? new MediaStream();
  let disposeMirroring = () => {};

  if (mirror !== false) {
    try {
      const videoTrack = inputStream.getVideoTracks?.()[0];
      if (videoTrack && (mirror === true || shouldMirrorTrack(videoTrack))) {
        const mirrored = createMirroredStream(inputStream, { fps });
        inputStream = mirrored.stream;
        disposeMirroring = mirrored.dispose;
      } else if (mirror === true && !videoTrack) {
        logger.warn("mirror: true requested but no video track was found on the input stream");
      }
    } catch (error) {
      logger.warn("Failed to mirror input stream; falling back to un-mirrored input", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Create the frame-metadata strip worker up front so we only advertise
  // `frame_timing` to the server once we know the room will have a strip
  // transform. Once frame timing is advertised the server appends a packet
  // trailer to every outgoing frame; a subscriber without the worker can't
  // strip it and the VP8/VP9 decoder then fails on every frame. Worker
  // availability is environment-deterministic, so this also predicts reconnects.
  let pendingWorker: Worker | undefined;
  if (debugQuality) {
    try {
      pendingWorker = createFrameMetadataWorker();
    } catch (error) {
      logger.warn("Frame-metadata worker unavailable; glass-to-glass latency measurement disabled", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const frameTiming = pendingWorker !== undefined;
  // Hand the pre-created worker to the first connect, then create a fresh one
  // per reconnect (LiveKit terminates the worker when its room disconnects).
  const takeFrameMetadataWorker = () => {
    if (pendingWorker) {
      const worker = pendingWorker;
      pendingWorker = undefined;
      return worker;
    }
    return createFrameMetadataWorker();
  };

  const observability = new RealtimeObservability({
    ...observabilityOptions,
    glassToGlass: frameTiming ? createBrowserFrameMetadataDiagnostics() : undefined,
  });

  const safariCodec = isDesktopSafari() ? "vp8" : undefined;
  return {
    stream: inputStream,
    observability,
    frameTiming,
    videoCodec: safariCodec ?? preferredVideoCodec,
    queryParams: {
      ...(safariCodec ? { livekit_server_codec: safariCodec } : {}),
    },
    createMediaChannel: (config) =>
      createLiveKitMediaChannel({
        ...config,
        createFrameMetadataWorker: frameTiming ? takeFrameMetadataWorker : undefined,
      }),
    dispose: () => {
      disposeMirroring();
      // Terminate the worker if connect never consumed it (e.g. aborted setup).
      pendingWorker?.terminate();
    },
  };
};
