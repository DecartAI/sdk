import type { Logger } from "../utils/logger";
import type { ConnectionQuality } from "./observability/connection-quality";
import type { ConnectivityReport, ConnectivityTransport, PreflightRttThresholds } from "./preflight-types";

function candidateType(candidate: RTCIceCandidate): string {
  if (candidate.type) return candidate.type;
  const match = /\btyp (\w+)/.exec(candidate.candidate);
  return match?.[1] ?? "";
}

type GatherResult = { transport: ConnectivityTransport; rttMs: number | null };

export async function gatherIceCandidates(
  iceServers: RTCIceServer[],
  timeoutMs: number,
  signal: AbortSignal | undefined,
  logger: Logger,
): Promise<GatherResult> {
  if (signal?.aborted) return { transport: "failed", rttMs: null };

  // biome-ignore lint/suspicious/noExplicitAny: runtime capability detection
  const PC = (globalThis as any)?.RTCPeerConnection as typeof RTCPeerConnection | undefined;
  if (typeof PC !== "function") {
    logger.warn("preflight: RTCPeerConnection unavailable in this environment");
    return { transport: "failed", rttMs: null };
  }

  let pc: RTCPeerConnection | null = null;
  try {
    pc = new PC({ iceServers });
    pc.createDataChannel("decart-preflight");

    let sawSrflx = false;
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
        if (!event.candidate || event.candidate.candidate === "") return finish();
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
    const transport: ConnectivityTransport = sawSrflx ? "udp" : sawOtherCandidate ? "relay" : "failed";
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
