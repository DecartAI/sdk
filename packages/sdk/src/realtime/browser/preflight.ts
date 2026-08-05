import { type CustomModelDefinition, type ModelDefinition, resolveFpsNumber } from "../../shared/model";
import type { Logger } from "../../utils/logger";
import type { RealTimeClient } from "../client";
import { REALTIME_CONFIG } from "../config-realtime";
import { type ConnectionQuality, extractSignals, scoreLowerBetter, worst } from "../observability/connection-quality";
import type { WebRTCStats } from "../observability/webrtc-stats";
import { classifyConnectivity, gatherIceCandidates } from "../preflight-connectivity";
import type {
  CheckConnectivityOptions,
  ConnectivityMetrics,
  ConnectivityReport,
  PreflightOptions,
  RealtimeConnect,
} from "../preflight-types";

export { classifyConnectivity } from "../preflight-connectivity";

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
        "Could not measure glass-to-glass latency during the probe (no frame metadata); using network RTT instead.",
      );
      dims.push(scoreLowerBetter(metrics.rttMs, thresholds.rtt.goodMs, thresholds.rtt.fairMs, thresholds.rtt.poorMs));
    } else {
      reasons.push("The probe connected but could not measure latency (no frame metadata and no RTT sample).");
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
 * Animated synthetic video source — no camera permission needed. It uses the
 * model's input dimensions to exercise the same encode/inference path as a real
 * session without unnecessary server-side resizing.
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

const ABORTED_DEEP_PROBE: ConnectivityReport = {
  quality: "fair",
  metrics: {
    transport: "failed",
    rttMs: null,
    g2gMs: null,
    ttffMs: null,
    g2gDropRatio: null,
    upstreamJitterMs: null,
    packetLoss: null,
    sampleCount: 0,
  },
  reasons: ["Deep connectivity probe aborted."],
};

/** Unblock `promise` early when `signal` aborts. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) throw signal.reason ?? createAbortError();
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason ?? createAbortError()), {
        once: true,
      });
    }),
  ]);
}

function createAbortError(): Error {
  const DOMExceptionConstructor = (globalThis as { DOMException?: typeof DOMException }).DOMException;
  if (typeof DOMExceptionConstructor === "function") return new DOMExceptionConstructor("Aborted", "AbortError");
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
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

  if (signal?.aborted) return ABORTED_DEEP_PROBE;

  try {
    // Match the model's exact input resolution to exercise the normal path.
    source = createSyntheticSource(model.width, model.height, resolveFpsNumber(model.fps));

    const connectTask = connect(source.stream, {
      model,
      debugQuality: true,
      onRemoteStream: () => {},
    });
    signal?.addEventListener("abort", () => connectTask.then((c) => c.disconnect()).catch(() => {}), {
      once: true,
    });
    client = await raceAbort(connectTask, signal);

    client.on("stats", (stats) => {
      latest = stats;
    });
    await waitForProbe(() => latest, REALTIME_CONFIG.preflight.active.minSamples, durationMs, signal);
    if (signal?.aborted) return ABORTED_DEEP_PROBE;
  } catch (error) {
    if (signal?.aborted) return ABORTED_DEEP_PROBE;
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
