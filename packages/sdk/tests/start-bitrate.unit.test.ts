import { describe, expect, it } from "vitest";
import { REALTIME_CONFIG } from "../src/realtime/config-realtime.js";
import { getVideoStartBitrateKbps, withVideoStartBitrate } from "../src/realtime/media-channel.js";

describe("start bitrate", () => {
  it("adds x-google-start-bitrate to video codecs (inserting an fmtp line for VP8), never audio, without duplicating", () => {
    const sdp = [
      "v=0",
      "m=audio 9 UDP/TLS/RTP/SAVPF 111",
      "a=fmtp:111 minptime=10;useinbandfec=1",
      "m=video 9 UDP/TLS/RTP/SAVPF 96 97 98 99",
      "a=rtpmap:96 H264/90000",
      "a=fmtp:96 packetization-mode=1;profile-level-id=42e01f",
      "a=rtpmap:97 rtx/90000",
      "a=fmtp:97 apt=96",
      "a=rtpmap:98 VP8/90000",
      "a=rtpmap:99 rtx/90000",
      "a=fmtp:99 apt=98",
      "",
    ].join("\r\n");
    const out = withVideoStartBitrate(sdp, 2138);
    expect(out).toContain("a=fmtp:96 packetization-mode=1;profile-level-id=42e01f;x-google-start-bitrate=2138\r\n");
    // VP8 has no fmtp line of its own (desktop Safari is pinned to VP8): one is inserted after its rtpmap.
    expect(out).toContain(
      "a=rtpmap:98 VP8/90000\r\na=fmtp:98 x-google-start-bitrate=2138\r\na=rtpmap:99 rtx/90000\r\n",
    );
    expect(out.match(/^a=fmtp:99 /gm)).toHaveLength(1); // RTX gets no inserted line
    expect(out).toContain("a=fmtp:111 minptime=10;useinbandfec=1\r\n");
    expect(withVideoStartBitrate(out, 999)).toBe(out);
  });

  it("computes the seed from the config (VP9 publishes a single layer)", () => {
    const { minVideoBitrateBps, simulcastLowerLayersBitrateBps, bweVideoShare } = REALTIME_CONFIG.livekit;
    expect(getVideoStartBitrateKbps()).toBe(
      Math.round((minVideoBitrateBps + simulcastLowerLayersBitrateBps) / bweVideoShare / 1000),
    );
    expect(getVideoStartBitrateKbps("h264")).toBe(2138);
    expect(getVideoStartBitrateKbps("vp9")).toBe(1375);
    expect(getVideoStartBitrateKbps()).toBe(REALTIME_CONFIG.observability.connectionQuality.upstream.fairKbps);
  });

  it("pins the simulcast lower-layer budget to the installed livekit-client presets", async () => {
    const { VideoPresets } = await import("livekit-client");
    expect(VideoPresets.h180.encoding.maxBitrate + VideoPresets.h360.encoding.maxBitrate).toBe(
      REALTIME_CONFIG.livekit.simulcastLowerLayersBitrateBps,
    );
  });

  it("derives the quality bands from the same constants", () => {
    expect(REALTIME_CONFIG.observability.connectionQuality.upstream).toEqual({
      goodKbps: 5138,
      fairKbps: 2138,
      poorKbps: 1450,
    });
  });
});
