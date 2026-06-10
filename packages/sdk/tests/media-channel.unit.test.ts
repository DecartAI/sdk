import { describe, expect, it, vi } from "vitest";

// media-channel.ts imports value bindings (Room, RoomEvent, Track) from
// livekit-client at module load. getDefaultVideoPublishOptions only reads
// Track.Source.Camera, so a minimal stub is enough to import it in node.
vi.mock("livekit-client", () => ({
  Room: class {},
  RoomEvent: { TrackSubscribed: "trackSubscribed", Disconnected: "disconnected" },
  Track: {
    Kind: { Video: "video", Audio: "audio" },
    Source: { Camera: "camera" },
  },
}));

import { REALTIME_CONFIG } from "../src/realtime/config-realtime.js";
import { getDefaultVideoPublishOptions, type VideoCodec } from "../src/realtime/media-channel.js";

const CODECS: VideoCodec[] = ["h264", "vp8", "vp9", "av1"];

describe("getDefaultVideoPublishOptions", () => {
  it("publishes a single (non-simulcast) camera layer for every codec", () => {
    // The camera publish feeds ONE subscriber (the inference server) and
    // dynacast/adaptiveStream are off, so simulcast layers are wasted uplink
    // and extra packets that amplify SFU ingress reorder/jitter.
    for (const codec of CODECS) {
      expect(getDefaultVideoPublishOptions(codec).simulcast).toBe(false);
    }
    expect(getDefaultVideoPublishOptions().simulcast).toBe(false);
  });

  it("prefers maintaining framerate (sheds resolution) under uplink pressure", () => {
    for (const codec of CODECS) {
      expect(getDefaultVideoPublishOptions(codec).degradationPreference).toBe("maintain-framerate");
    }
  });

  it("targets the camera source and forwards the configured publish fps", () => {
    const opts = getDefaultVideoPublishOptions("h264");
    expect(opts.source).toBe("camera");
    expect(opts.videoEncoding?.maxFramerate).toBe(REALTIME_CONFIG.livekit.defaultPublishFps);
  });

  it("caps bitrate with the vp9-specific limit for vp9 and the default otherwise", () => {
    expect(getDefaultVideoPublishOptions("vp9").videoEncoding?.maxBitrate).toBe(
      REALTIME_CONFIG.livekit.vp9MaxVideoBitrateBps,
    );
    expect(getDefaultVideoPublishOptions("h264").videoEncoding?.maxBitrate).toBe(
      REALTIME_CONFIG.livekit.defaultMaxVideoBitrateBps,
    );
  });
});
