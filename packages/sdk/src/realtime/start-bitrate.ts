import type { Logger } from "../utils/logger";

/**
 * Video codecs whose fmtp carries `x-google-start-bitrate`. Payload types are
 * matched from `a=rtpmap` so retransmission/FEC payloads (rtx, red, ulpfec —
 * also clocked at /90000) are never munged.
 */
const VIDEO_CODEC_RTPMAP = /^a=rtpmap:(\d+) (VP8|VP9|H264|H265|AV1)\/90000/i;

/**
 * Append `x-google-start-bitrate=<kbps>` to every video codec's fmtp in the
 * SDP (adding an fmtp line when the codec has none — VP8 typically doesn't).
 *
 * libwebrtc reads the parameter off the applied session descriptions and uses
 * it as the initial send-side bandwidth estimate, replacing the stock
 * ~300 kbps cold start. Idempotent: descriptions that already carry the
 * parameter (e.g. on a renegotiation of an already-munged session) are left
 * untouched.
 */
export function mungeStartBitrate(sdp: string, startKbps: number): string {
  if (!(startKbps > 0)) return sdp;
  const lines = sdp.split("\r\n");

  const videoPts = new Set<string>();
  const ptsWithFmtp = new Set<string>();
  for (const line of lines) {
    const rtpmap = line.match(VIDEO_CODEC_RTPMAP);
    if (rtpmap?.[1]) videoPts.add(rtpmap[1]);
    const fmtp = line.match(/^a=fmtp:(\d+) /);
    if (fmtp?.[1]) ptsWithFmtp.add(fmtp[1]);
  }
  if (videoPts.size === 0) return sdp;

  const param = `x-google-start-bitrate=${startKbps}`;
  const out: string[] = [];
  for (const line of lines) {
    const fmtp = line.match(/^a=fmtp:(\d+) (.+)$/);
    if (fmtp?.[1] && fmtp[2] && videoPts.has(fmtp[1]) && !line.includes("x-google-start-bitrate")) {
      out.push(`a=fmtp:${fmtp[1]} ${fmtp[2]};${param}`);
      continue;
    }
    out.push(line);
    const rtpmap = line.match(VIDEO_CODEC_RTPMAP);
    if (rtpmap?.[1] && !ptsWithFmtp.has(rtpmap[1])) {
      // Codec has no fmtp line anywhere in the SDP — give it one so the
      // parameter still reaches libwebrtc (fmtp placement after rtpmap is
      // valid and conventional).
      out.push(`a=fmtp:${rtpmap[1]} ${param}`);
      ptsWithFmtp.add(rtpmap[1]);
    }
  }
  return out.join("\r\n");
}

/**
 * Patch the global `RTCPeerConnection` so every description applied while the
 * patch is installed — local offers and remote answers alike, across LiveKit
 * reconnects — carries the start-bitrate parameter. Returns an uninstaller.
 *
 * Patching the global is deliberate: livekit-client owns its peer connections
 * and exposes no SDP hook, and this is the exact mechanism validated on the
 * probe rig. The uninstaller restores the original constructor only if nobody
 * else has re-patched the global since (never clobbers a foreign patch).
 */
export function installStartBitrateMunge(startKbps: number, logger?: Logger): () => void {
  if (!(startKbps > 0)) return () => {};
  const g = globalThis as { RTCPeerConnection?: typeof RTCPeerConnection };
  const OriginalPC = g.RTCPeerConnection;
  if (typeof OriginalPC !== "function") {
    logger?.warn("startBitrateKbps ignored: no global RTCPeerConnection in this environment");
    return () => {};
  }

  let logged = false;
  const logOnce = (leg: string) => {
    if (logged) return;
    logged = true;
    logger?.info(`publisher start-bitrate seeded to ${startKbps} kbps (x-google-start-bitrate, ${leg})`);
  };

  const munged = <T extends { type?: RTCSdpType; sdp?: string }>(description: T, leg: string): T => {
    if (typeof description.sdp !== "string") return description;
    const sdp = mungeStartBitrate(description.sdp, startKbps);
    if (sdp === description.sdp) return description;
    logOnce(leg);
    return { ...description, sdp };
  };

  class StartBitratePC extends OriginalPC {
    // Seed ONLY the first offer/answer pair. libwebrtc re-initializes the
    // send-side estimate to x-google-start-bitrate on EVERY applied
    // description that carries it — munging renegotiations (e.g. LiveKit's
    // track-publish round) resets an already-converged estimator back down
    // to the seed (measured live: est 5301 kbps → 1106 kbps at the second
    // negotiation, exactly the seed value).
    #mungedLegs = 0;

    #maybeMunge<T extends { type?: RTCSdpType; sdp?: string }>(description: T, leg: string): T {
      if (this.#mungedLegs >= 2) return description;
      const result = munged(description, leg);
      if (result !== description) this.#mungedLegs++;
      return result;
    }

    override setLocalDescription(description?: RTCLocalSessionDescriptionInit): Promise<void> {
      // Argless form (implicit offer/answer) has no SDP to munge — the
      // browser builds the description internally; the remote-answer leg
      // still seeds those sessions.
      if (description === undefined) return super.setLocalDescription();
      return super.setLocalDescription(this.#maybeMunge(description, "local offer"));
    }
    override setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
      return super.setRemoteDescription(this.#maybeMunge(description, "remote answer"));
    }
  }

  try {
    g.RTCPeerConnection = StartBitratePC as typeof RTCPeerConnection;
  } catch (error) {
    logger?.warn("startBitrateKbps ignored: RTCPeerConnection global is not patchable", {
      error: error instanceof Error ? error.message : String(error),
    });
    return () => {};
  }

  return () => {
    if (g.RTCPeerConnection === StartBitratePC) {
      g.RTCPeerConnection = OriginalPC;
    }
  };
}
