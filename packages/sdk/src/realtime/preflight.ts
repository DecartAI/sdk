import { type CustomModelDefinition, type ModelDefinition, resolveFpsNumber } from "../shared/model";
import type { Logger } from "../utils/logger";
import type { RealTimeClient, RealTimeClientConnectOptions } from "./client";
import { REALTIME_CONFIG } from "./config-realtime";
import { type ConnectionQuality, extractSignals, scoreLowerBetter, worst } from "./observability/connection-quality";
import type { WebRTCStats } from "./observability/webrtc-stats";

/**
 * SDK-only connectivity preflight — run before `realtime.connect()` to decide
 * whether to show the integration. Spins up a throwaway `RTCPeerConnection`
 * against public STUN (no session, no inference) to check whether WebRTC can
 * leave the network over UDP and roughly how laggy the path is. It does not
 * measure throughput — use the in-session `connectionQuality` signal for that.
 */
export type ConnectivityTransport = "udp" | "relay" | "failed";

export type ConnectivityMetrics = {
  /** "udp" = direct UDP works · "relay" = will need TURN (unverified SDK-only) · "failed" = no connectivity. */
  transport: ConnectivityTransport;
  /** Approximate network round-trip time (ms) from time-to-first STUN candidate (or real RTT in deep mode), or null. */
  rttMs: number | null;
  /** Active-probe only: measured mid-stream (steady-state) glass-to-glass latency (ms), or null. */
  g2gMs?: number | null;
  /** Active-probe only: time-to-first-frame (ms) — startup latency to the first rendered model frame, or null. */
  ttffMs?: number | null;
  /** Active-probe only: end-to-end frame drop ratio (0–1), or null. */
  g2gDropRatio?: number | null;
  /** Active-probe only: server's view of upstream jitter (ms), or null. */
  upstreamJitterMs?: number | null;
  /** Active-probe only: server-reported upstream packet loss (0–1), or null. */
  packetLoss?: number | null;
  /** Active-probe only: number of glass-to-glass samples collected. */
  sampleCount?: number;
};

export type ConnectivityReport = {
  /** Pre-connect quality on the same `good → critical` scale as the in-session signal — you decide what to do. */
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
  /**
   * Opt-in "deep" probe: instead of the STUN-only network check, briefly open a
   * real session with a synthetic source, measure true glass-to-glass latency,
   * then tear it down. Requires `model`. Costs a short GPU session.
   */
  deep?: boolean;
  /** Required when `deep`: the realtime model to probe (latency is model-specific). */
  model?: ModelDefinition | CustomModelDefinition;
  /** Deep-probe duration (ms). Defaults to config. */
  durationMs?: number;
};

/** Realtime `connect` injected by the SDK root so the active probe can open a session. */
type RealtimeConnect = (stream: MediaStream | null, options: RealTimeClientConnectOptions) => Promise<RealTimeClient>;

export type PreflightOptions = {
  logger: Logger;
  /** Injected by the SDK root; enables the opt-in active probe. */
  connect?: RealtimeConnect;
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

// --- Active probe (opt-in) ---------------------------------------------------

/** Thresholds the active-probe verdict reuses from the in-session quality config. */
type ActiveProbeThresholds = Pick<
  typeof REALTIME_CONFIG.observability.connectionQuality,
  "rtt" | "glassToGlass" | "ttff" | "loss" | "g2gDrop"
>;

/**
 * Classify an active-probe result. Judges startup (TTFF) and steady-state
 * (mid-stream glass-to-glass) latency separately — both are real experienced
 * latency on different scales — and folds in drops + upstream loss. Falls back
 * to RTT only when neither latency could be measured. Pure.
 */
export function classifyActiveProbe(
  metrics: ConnectivityMetrics,
  thresholds: ActiveProbeThresholds,
): ConnectivityReport {
  const reasons: string[] = [];

  if (metrics.transport === "failed") {
    return {
      quality: "critical",
      metrics,
      reasons: ["Could not establish a realtime session for the deep probe."],
    };
  }

  const dims: ConnectionQuality[] = [];

  if (metrics.ttffMs != null) {
    const t = thresholds.ttff;
    const q = scoreLowerBetter(metrics.ttffMs, t.goodMs, t.fairMs, t.poorMs);
    dims.push(q);
    if (q !== "good") {
      reasons.push(
        `Time to first frame is ~${(metrics.ttffMs / 1000).toFixed(1)}s (good ≤ ${(t.goodMs / 1000).toFixed(0)}s); the session is slow to start.`,
      );
    }
  }

  if (metrics.g2gMs != null) {
    const g = thresholds.glassToGlass;
    const q = scoreLowerBetter(metrics.g2gMs, g.goodMs, g.fairMs, g.poorMs);
    dims.push(q);
    if (q !== "good") {
      reasons.push(
        `Mid-stream glass-to-glass latency is ~${metrics.g2gMs}ms (good ≤ ${g.goodMs}ms); the real-time experience may feel laggy.`,
      );
    }
  }

  if (metrics.ttffMs == null && metrics.g2gMs == null) {
    if (metrics.rttMs != null) {
      reasons.push(
        "Could not measure glass-to-glass latency during the probe (no marker round-trip); using network RTT instead.",
      );
      dims.push(scoreLowerBetter(metrics.rttMs, thresholds.rtt.goodMs, thresholds.rtt.fairMs, thresholds.rtt.poorMs));
    } else {
      reasons.push("The probe connected but could not measure latency (no marker round-trip and no RTT sample).");
    }
  }

  if (metrics.g2gDropRatio != null) {
    const d = thresholds.g2gDrop;
    const q = scoreLowerBetter(metrics.g2gDropRatio, d.good, d.fair, d.poor);
    dims.push(q);
    if (q !== "good") {
      reasons.push(
        `End-to-end frame drop ratio is ${(metrics.g2gDropRatio * 100).toFixed(1)}% (good ≤ ${d.good * 100}%).`,
      );
    }
  }

  if (metrics.packetLoss != null) {
    const l = thresholds.loss;
    const q = scoreLowerBetter(metrics.packetLoss, l.good, l.fair, l.poor);
    dims.push(q);
    if (q !== "good") {
      reasons.push(`Upstream packet loss is ${(metrics.packetLoss * 100).toFixed(1)}% (good ≤ ${l.good * 100}%).`);
    }
  }

  // The session connected (transport !== "failed") but produced no usable
  // quality signal — don't claim "good" we never verified. Report "fair" so the
  // caller treats it as connected-but-unverified, with the reason explaining why.
  if (dims.length === 0) {
    return { quality: "fair", metrics, reasons };
  }

  return { quality: worst(...dims), metrics, reasons };
}

/** Derive active-probe metrics from the latest in-session stats sample. */
function activeMetricsFromStats(stats: WebRTCStats | null): ConnectivityMetrics {
  if (!stats) {
    // Connected but no stats arrived yet — connectivity works, just unmeasured.
    return {
      transport: "udp",
      rttMs: null,
      g2gMs: null,
      ttffMs: null,
      g2gDropRatio: null,
      upstreamJitterMs: null,
      packetLoss: null,
      sampleCount: 0,
    };
  }
  // Reuse the in-session signal extractor so the RTT fallback, RFC-3550 loss
  // normalization, jitter conversion, and relay detection stay in one place.
  const s = extractSignals(stats);
  return {
    transport: s.isRelayed ? "relay" : "udp",
    rttMs: s.rttMs != null ? Math.round(s.rttMs) : null,
    g2gMs: s.g2gMs,
    ttffMs: s.ttffMs,
    g2gDropRatio: s.g2gDropRatio,
    upstreamJitterMs: s.upstreamJitterMs != null ? Math.round(s.upstreamJitterMs) : null,
    packetLoss: s.fractionLost,
    sampleCount: stats.glassToGlass?.sampleCount ?? 0,
  };
}

/**
 * Animated synthetic video source — no camera permission needed; content is
 * irrelevant to the marker. Sized to the model's exact input dimensions so the
 * server doesn't resize/crop the frame, which would move the bottom-left marker
 * out of where the server reads it (breaking the round trip).
 */
function createSyntheticSource(
  width: number,
  height: number,
  fps: number,
): { stream: MediaStream; dispose: () => void } {
  if (typeof document === "undefined") {
    throw new Error("deep connectivity probe requires a DOM environment (document is undefined)");
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("deep connectivity probe: 2D canvas context unavailable");
  if (typeof canvas.captureStream !== "function") {
    throw new Error("deep connectivity probe: canvas.captureStream unavailable");
  }

  let rafHandle: number | null = null;
  let frame = 0;
  const draw = () => {
    frame++;
    // Animate so the encoder produces real frames at the target rate.
    ctx.fillStyle = `hsl(${frame % 360}, 60%, 50%)`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "white";
    ctx.fillRect((frame * 7) % canvas.width, 48, 96, 96);
    rafHandle = requestAnimationFrame(draw);
  };
  rafHandle = requestAnimationFrame(draw);

  const stream = canvas.captureStream(fps);
  return {
    stream,
    dispose: () => {
      if (rafHandle !== null) cancelAnimationFrame(rafHandle);
      for (const track of stream.getTracks()) track.stop();
    },
  };
}

/** Resolve once enough g2g samples exist or the probe window elapses (never rejects). */
function waitForProbe(
  getLatest: () => WebRTCStats | null,
  minSamples: number,
  durationMs: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  return new Promise((resolve) => {
    const start = performance.now();
    const tick = () => {
      if (signal?.aborted) return resolve();
      if ((getLatest()?.glassToGlass?.sampleCount ?? 0) >= minSamples) return resolve();
      if (performance.now() - start >= durationMs) return resolve();
      setTimeout(tick, 200);
    };
    setTimeout(tick, 200);
  });
}

async function runActiveProbe(args: {
  connect: RealtimeConnect;
  logger: Logger;
  model: ModelDefinition | CustomModelDefinition;
  durationMs: number;
  signal: AbortSignal | undefined;
}): Promise<ConnectivityReport> {
  const { connect, logger, model, durationMs, signal } = args;
  const thresholds = REALTIME_CONFIG.observability.connectionQuality;

  let source: { stream: MediaStream; dispose: () => void } | undefined;
  let client: RealTimeClient | undefined;
  let latest: WebRTCStats | null = null;

  try {
    // Match the model's exact input resolution so the server processes the frame
    // without reshaping it (which would corrupt the bottom-left pixel marker).
    source = createSyntheticSource(model.width, model.height, resolveFpsNumber(model.fps));
    client = await connect(source.stream, {
      model,
      debugQuality: true,
      onRemoteStream: () => {},
    });
    client.on("stats", (stats) => {
      latest = stats;
    });
    await waitForProbe(() => latest, REALTIME_CONFIG.preflight.active.minSamples, durationMs, signal);
  } catch (error) {
    logger.warn("deep connectivity probe failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return classifyActiveProbe(
      {
        transport: "failed",
        rttMs: null,
        g2gMs: null,
        g2gDropRatio: null,
        upstreamJitterMs: null,
        packetLoss: null,
        sampleCount: 0,
      },
      thresholds,
    );
  } finally {
    client?.disconnect();
    source?.dispose();
  }

  return classifyActiveProbe(activeMetricsFromStats(latest), thresholds);
}

const DEFAULT_ICE_SERVERS: RTCIceServer[] = REALTIME_CONFIG.preflight.defaultStunUrls.map((urls) => ({ urls }));

export const createPreflight = ({ logger, connect }: PreflightOptions) => {
  const checkConnectivity = async (options: CheckConnectivityOptions = {}): Promise<ConnectivityReport> => {
    if (options.deep) {
      if (!connect) {
        throw new Error("deep connectivity probe is unavailable (realtime client not wired)");
      }
      if (!options.model) {
        throw new Error("deep connectivity probe requires a `model` (latency is model-specific)");
      }
      return runActiveProbe({
        connect,
        logger,
        model: options.model,
        durationMs: options.durationMs ?? REALTIME_CONFIG.preflight.active.durationMs,
        signal: options.signal,
      });
    }

    const iceServers = options.iceServers ?? DEFAULT_ICE_SERVERS;
    const timeoutMs = options.iceGatherTimeoutMs ?? REALTIME_CONFIG.preflight.iceGatherTimeoutMs;
    const result = await gatherIceCandidates(iceServers, timeoutMs, options.signal, logger);
    return classifyConnectivity(result, REALTIME_CONFIG.preflight.rtt);
  };

  return { checkConnectivity };
};
