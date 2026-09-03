import { describe, expect, it } from "vitest";

import { REALTIME_CONFIG } from "../src/realtime/config-realtime";
import { getDefaultVideoPublishOptions } from "../src/realtime/media-channel";

const NATURAL_H264 = REALTIME_CONFIG.livekit.defaultMaxVideoBitrateBps;
const NATURAL_VP9 = REALTIME_CONFIG.livekit.vp9MaxVideoBitrateBps;

describe("getDefaultVideoPublishOptions low-fps bitrate scaling", () => {
  it("keeps the natural bitrate at the default 30 fps", () => {
    const opts = getDefaultVideoPublishOptions("camera", "h264", false, 30);
    expect(opts.videoEncoding?.maxBitrate).toBe(NATURAL_H264);
  });

  it("keeps the natural bitrate when fps is omitted (registry models)", () => {
    const opts = getDefaultVideoPublishOptions("camera", "h264", false);
    expect(opts.videoEncoding?.maxBitrate).toBe(NATURAL_H264);
  });

  it("does NOT engage at 15 fps (binding caps measurably hurt at >=15 fps)", () => {
    const opts = getDefaultVideoPublishOptions("camera", "h264", false, 15);
    expect(opts.videoEncoding?.maxBitrate).toBe(NATURAL_H264);
  });

  it("scales to ~200 kbit/frame at 10 fps", () => {
    const opts = getDefaultVideoPublishOptions("camera", "h264", false, 10);
    expect(opts.videoEncoding?.maxBitrate).toBe(10 * REALTIME_CONFIG.livekit.lowFpsBitsPerFrame);
  });

  it("never drops below the viability floor at very low fps", () => {
    const opts = getDefaultVideoPublishOptions("camera", "h264", false, 2);
    expect(opts.videoEncoding?.maxBitrate).toBe(REALTIME_CONFIG.livekit.lowFpsMinBitrateBps);
  });

  it("never exceeds the codec's natural bitrate", () => {
    const opts = getDefaultVideoPublishOptions("camera", "vp9", false, 14.9);
    expect(opts.videoEncoding?.maxBitrate).toBeLessThanOrEqual(NATURAL_VP9);
  });
});
