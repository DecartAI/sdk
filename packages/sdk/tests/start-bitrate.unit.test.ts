import { afterEach, describe, expect, it, vi } from "vitest";
import { installStartBitrateMunge, mungeStartBitrate } from "../src/realtime/start-bitrate.js";

const SDP = [
  "v=0",
  "o=- 1 1 IN IP4 127.0.0.1",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111",
  "a=rtpmap:111 opus/48000/2",
  "a=fmtp:111 minptime=10;useinbandfec=1",
  "m=video 9 UDP/TLS/RTP/SAVPF 96 97 98 99 100",
  "a=rtpmap:96 VP9/90000",
  "a=fmtp:96 profile-id=0",
  "a=rtpmap:97 rtx/90000",
  "a=fmtp:97 apt=96",
  "a=rtpmap:98 VP8/90000",
  "a=rtpmap:99 H264/90000",
  "a=fmtp:99 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
  "a=rtpmap:100 red/90000",
  "",
].join("\r\n");

describe("mungeStartBitrate", () => {
  it("appends the parameter to every video codec fmtp — VP9 and H264, both payload types", () => {
    const out = mungeStartBitrate(SDP, 1100);
    expect(out).toContain("a=fmtp:96 profile-id=0;x-google-start-bitrate=1100");
    expect(out).toContain(
      "a=fmtp:99 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f;x-google-start-bitrate=1100",
    );
  });

  it("adds an fmtp line for video codecs that have none (VP8)", () => {
    const out = mungeStartBitrate(SDP, 1100);
    const lines = out.split("\r\n");
    const vp8Index = lines.indexOf("a=rtpmap:98 VP8/90000");
    expect(lines[vp8Index + 1]).toBe("a=fmtp:98 x-google-start-bitrate=1100");
  });

  it("never touches audio, rtx, or red payloads", () => {
    const out = mungeStartBitrate(SDP, 1100);
    expect(out).toContain("a=fmtp:111 minptime=10;useinbandfec=1");
    expect(out).toContain("a=fmtp:97 apt=96");
    expect(out).not.toContain("a=fmtp:97 apt=96;x-google");
    expect(out).not.toContain("a=fmtp:100");
  });

  it("is idempotent: an already-munged description is returned unchanged", () => {
    const once = mungeStartBitrate(SDP, 1100);
    expect(mungeStartBitrate(once, 1100)).toBe(once);
  });

  it("is the identity for non-positive values and video-free SDPs", () => {
    expect(mungeStartBitrate(SDP, 0)).toBe(SDP);
    const audioOnly = "m=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2";
    expect(mungeStartBitrate(audioOnly, 1100)).toBe(audioOnly);
  });
});

type AnyDescription = { type?: string; sdp?: string } | undefined;

class FakePC {
  static instances: FakePC[] = [];
  lastLocal: AnyDescription | "ARGLESS";
  lastRemote: AnyDescription;
  constructor() {
    FakePC.instances.push(this);
  }
  setLocalDescription(...args: [AnyDescription?]): Promise<void> {
    this.lastLocal = args.length === 0 ? "ARGLESS" : args[0];
    return Promise.resolve();
  }
  setRemoteDescription(description: AnyDescription): Promise<void> {
    this.lastRemote = description;
    return Promise.resolve();
  }
}

const g = globalThis as { RTCPeerConnection?: unknown };

describe("installStartBitrateMunge", () => {
  afterEach(() => {
    delete g.RTCPeerConnection;
    FakePC.instances = [];
  });

  it("munges local offers and remote answers on connections created while installed", async () => {
    g.RTCPeerConnection = FakePC;
    const uninstall = installStartBitrateMunge(1100);
    const pc = new (g.RTCPeerConnection as new () => FakePC)();

    await pc.setLocalDescription({ type: "offer", sdp: SDP });
    expect((pc.lastLocal as { sdp: string }).sdp).toContain("x-google-start-bitrate=1100");

    await pc.setRemoteDescription({ type: "answer", sdp: SDP });
    expect((pc.lastRemote as { sdp: string }).sdp).toContain("x-google-start-bitrate=1100");
    uninstall();
  });

  it("passes the argless setLocalDescription form through untouched", async () => {
    g.RTCPeerConnection = FakePC;
    const uninstall = installStartBitrateMunge(1100);
    const pc = new (g.RTCPeerConnection as new () => FakePC)();
    await pc.setLocalDescription();
    expect(pc.lastLocal).toBe("ARGLESS");
    uninstall();
  });

  it("logs once on the first munged description", async () => {
    g.RTCPeerConnection = FakePC;
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const uninstall = installStartBitrateMunge(1100, logger);
    const pc = new (g.RTCPeerConnection as new () => FakePC)();
    await pc.setLocalDescription({ type: "offer", sdp: SDP });
    await pc.setRemoteDescription({ type: "answer", sdp: SDP });
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info.mock.calls[0]?.[0]).toContain("1100 kbps");
    uninstall();
  });

  it("uninstall restores the original constructor, but never clobbers a foreign patch", () => {
    g.RTCPeerConnection = FakePC;
    const uninstall = installStartBitrateMunge(1100);
    expect(g.RTCPeerConnection).not.toBe(FakePC);

    const foreign = class {};
    g.RTCPeerConnection = foreign;
    uninstall();
    expect(g.RTCPeerConnection).toBe(foreign);

    g.RTCPeerConnection = FakePC;
    const uninstall2 = installStartBitrateMunge(1100);
    uninstall2();
    expect(g.RTCPeerConnection).toBe(FakePC);
  });

  it("is a no-op without a global RTCPeerConnection or for non-positive values", () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    expect(installStartBitrateMunge(1100, logger)).toBeTypeOf("function");
    expect(logger.warn).toHaveBeenCalledOnce();

    g.RTCPeerConnection = FakePC;
    installStartBitrateMunge(0)();
    expect(g.RTCPeerConnection).toBe(FakePC);
  });
});
