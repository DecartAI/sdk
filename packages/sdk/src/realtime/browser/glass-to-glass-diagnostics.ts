import type { GlassToGlassDiagnostics } from "../observability/realtime-observability";
import { createMarkerReader, createStampPump, type MarkerReader, SeqTracker, type StampPump } from "./glass-to-glass";

export function createBrowserGlassToGlassDiagnostics(): GlassToGlassDiagnostics {
  const tracker = new SeqTracker();
  const reader: MarkerReader = createMarkerReader(tracker);
  let pump: StampPump | undefined;

  return {
    attachOutgoingStream: (stream, fps) => {
      pump?.dispose();
      pump = createStampPump(stream, { tracker, fps });
      return pump.stream;
    },
    attachRemoteVideoTrack: (track) => reader.attach(track),
    markStart: () => tracker.markStart(performance.now()),
    snapshot: () => tracker.snapshot(),
    dispose: () => {
      pump?.dispose();
      pump = undefined;
      reader.dispose();
    },
  };
}
