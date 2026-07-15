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

  const observability = new RealtimeObservability({
    ...observabilityOptions,
    glassToGlass: debugQuality ? createBrowserFrameMetadataDiagnostics() : undefined,
  });

  const safariCodec = isDesktopSafari() ? "vp8" : undefined;
  return {
    stream: inputStream,
    observability,
    frameTiming: debugQuality,
    videoCodec: safariCodec ?? preferredVideoCodec,
    queryParams: {
      ...(safariCodec ? { livekit_server_codec: safariCodec } : {}),
    },
    createMediaChannel: (config) =>
      createLiveKitMediaChannel({
        ...config,
        createFrameMetadataWorker: debugQuality ? createFrameMetadataWorker : undefined,
      }),
    dispose: disposeMirroring,
  };
};
