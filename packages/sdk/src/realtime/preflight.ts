import type { Logger } from "../utils/logger";
import { REALTIME_CONFIG } from "./config-realtime";
import type { ConnectionQuality } from "./observability/connection-quality";

/**
 * SDK-only connectivity preflight. Run this *before* `realtime.connect()` to
 * decide whether to show/enable the integration. It does NOT start a session
 * or consume any inference — it spins up a throwaway `RTCPeerConnection`
 * against public STUN servers to answer two questions cheaply:
 *
 *  1. Can WebRTC even leave this network over UDP? (the dominant failure on
 *     corporate / locked-down networks)
 *  2. Roughly how laggy is the path? (time-to-first-reflexive-candidate)
 *
 * It deliberately does NOT measure upstream throughput — that can't be done
 * accurately without a backend echo room or upload sink. Use the in-session
 * `connectionQuality` signal (which sees real BWE a couple seconds after
 * connect) for the throughput question.
 */
export type ConnectivityTransport = "udp" | "relay" | "failed";

export type ConnectivityMetrics = {
  /** "udp" = direct UDP works · "relay" = will need TURN (unverified SDK-only) · "failed" = no connectivity. */
  transport: ConnectivityTransport;
  /** Approximate network round-trip time (ms) from time-to-first STUN candidate, or null. */
  rttMs: number | null;
};

export type ConnectivityReport = {
  /**
   * Pre-connect connection quality, on the same `good → critical` scale as the
   * in-session signal. The SDK reports the state and leaves the decision to you
   * — e.g. show on "good", warn on "fair"/"poor", hide on "critical".
   */
  quality: ConnectionQuality;
  metrics: ConnectivityMetrics;
  /** Human-readable explanations for any non-"good" verdict. */
  reasons: string[];
};

export type CheckConnectivityOptions = {
  /** Override the ICE servers used for the probe. Defaults to public STUN. */
  iceServers?: RTCIceServer[];
  /** Abort candidate gathering after this long. Defaults to config. */
  iceGatherTimeoutMs?: number;
  /** Abort the probe early. */
  signal?: AbortSignal;
};

export type PreflightOptions = {
  logger: Logger;
};

export type PreflightRttThresholds = { goodMs: number; marginalMs: number };

/** Extract the candidate type ("host" | "srflx" | "prflx" | "relay") from an ICE candidate. */
function candidateType(candidate: RTCIceCandidate): string {
  if (candidate.type) return candidate.type;
  const match = /\btyp (\w+)/.exec(candidate.candidate);
  return match?.[1] ?? "";
}

type GatherResult = { transport: ConnectivityTransport; rttMs: number | null };

async function gatherIceCandidates(
  iceServers: RTCIceServer[],
  timeoutMs: number,
  signal: AbortSignal | undefined,
  logger: Logger,
): Promise<GatherResult> {
  // Already-aborted signal: bail before allocating a peer connection or waiting.
  if (signal?.aborted) {
    return { transport: "failed", rttMs: null };
  }

  // biome-ignore lint/suspicious/noExplicitAny: runtime capability detection
  const PC = (globalThis as any)?.RTCPeerConnection as typeof RTCPeerConnection | undefined;
  if (typeof PC !== "function") {
    logger.warn("preflight: RTCPeerConnection unavailable in this environment");
    return { transport: "failed", rttMs: null };
  }

  let pc: RTCPeerConnection | null = null;
  try {
    pc = new PC({ iceServers });
    // A data channel gives us an m-section so ICE gathering actually runs,
    // without needing camera permission or any media tracks.
    pc.createDataChannel("decart-preflight");

    let sawSrflx = false;
    // host or relay candidate — proves we gathered *something* but not direct UDP egress.
    let sawOtherCandidate = false;
    let firstSrflxAt: number | null = null;
    const start = performance.now();

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      signal?.addEventListener("abort", finish, { once: true });

      const peer = pc as RTCPeerConnection;
      peer.onicecandidate = (event) => {
        if (!event.candidate || event.candidate.candidate === "") {
          finish(); // end-of-candidates
          return;
        }
        if (candidateType(event.candidate) === "srflx") {
          sawSrflx = true;
          if (firstSrflxAt === null) firstSrflxAt = performance.now();
        } else {
          sawOtherCandidate = true;
        }
      };
      peer.onicegatheringstatechange = () => {
        if (peer.iceGatheringState === "complete") finish();
      };

      peer
        .createOffer()
        .then((offer) => peer.setLocalDescription(offer))
        .catch((error) => {
          logger.warn("preflight: failed to create offer", {
            error: error instanceof Error ? error.message : String(error),
          });
          finish();
        });
    });

    const rttMs = firstSrflxAt !== null ? Math.round(firstSrflxAt - start) : null;

    // srflx → confirmed UDP egress; any other candidate but no srflx → STUN
    // unreachable over UDP, the session will need TURN; nothing at all → failed.
    let transport: ConnectivityTransport;
    if (sawSrflx) {
      transport = "udp";
    } else if (sawOtherCandidate) {
      transport = "relay";
    } else {
      transport = "failed";
    }
    return { transport, rttMs };
  } catch (error) {
    logger.warn("preflight: connectivity probe threw", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { transport: "failed", rttMs: null };
  } finally {
    try {
      pc?.close();
    } catch {
      // ignore teardown errors
    }
  }
}

/** Map probe metrics to a connectivity quality verdict. Pure. */
export function classifyConnectivity(
  metrics: { transport: ConnectivityTransport; rttMs: number | null },
  thresholds: PreflightRttThresholds,
): ConnectivityReport {
  const reasons: string[] = [];
  let quality: ConnectionQuality;

  if (metrics.transport === "failed") {
    quality = "critical";
    reasons.push(
      "Could not establish any WebRTC connectivity (no ICE candidates gathered). Real-time streaming is unlikely to work on this network.",
    );
  } else if (metrics.transport === "relay") {
    quality = "poor";
    reasons.push(
      "Direct UDP connectivity could not be confirmed; the session will need a TURN relay, which adds latency and can't be verified without starting a session.",
    );
  } else if (metrics.rttMs != null && metrics.rttMs > thresholds.marginalMs) {
    quality = "poor";
    reasons.push(
      `Network round-trip time is high (~${metrics.rttMs}ms > ${thresholds.marginalMs}ms); the real-time experience may feel laggy.`,
    );
  } else if (metrics.rttMs != null && metrics.rttMs > thresholds.goodMs) {
    quality = "fair";
    reasons.push(`Network round-trip time is elevated (~${metrics.rttMs}ms > ${thresholds.goodMs}ms).`);
  } else {
    quality = "good";
  }

  return {
    quality,
    metrics: { transport: metrics.transport, rttMs: metrics.rttMs },
    reasons,
  };
}

const DEFAULT_ICE_SERVERS: RTCIceServer[] = REALTIME_CONFIG.preflight.defaultStunUrls.map((urls) => ({ urls }));

export const createPreflight = ({ logger }: PreflightOptions) => {
  const checkConnectivity = async (options: CheckConnectivityOptions = {}): Promise<ConnectivityReport> => {
    const iceServers = options.iceServers ?? DEFAULT_ICE_SERVERS;
    const timeoutMs = options.iceGatherTimeoutMs ?? REALTIME_CONFIG.preflight.iceGatherTimeoutMs;
    const result = await gatherIceCandidates(iceServers, timeoutMs, options.signal, logger);
    return classifyConnectivity(result, REALTIME_CONFIG.preflight.rtt);
  };

  return { checkConnectivity };
};
