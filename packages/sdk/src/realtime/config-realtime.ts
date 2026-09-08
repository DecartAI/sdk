/** Publish bitrate floor for the primary video layer (bps). */
const MIN_VIDEO_BITRATE_BPS = 1_100_000;
/** Publish bitrate cap for the primary video layer (bps). */
const MAX_VIDEO_BITRATE_BPS = 3_500_000;
/** Combined max bitrate of livekit-client's default lower simulcast layers (bps); pinned by a unit test. */
const SIMULCAST_LOWER_LAYERS_BPS = 610_000;
/** Fraction of the bandwidth estimate available to the video encoders. */
const BWE_VIDEO_SHARE = 0.8;

/** Bandwidth estimate (kbps) needed for the primary layer to reach `primaryBps`. */
function estimateKbpsFor(primaryBps: number): number {
  return Math.round((primaryBps + SIMULCAST_LOWER_LAYERS_BPS) / BWE_VIDEO_SHARE / 1000);
}

export const REALTIME_CONFIG = {
  signaling: {
    connectTimeoutMs: 60_000,
    handshakeTimeoutMs: 15_000,
    requestTimeoutMs: 30_000,
  },
  session: {
    connectionTimeoutMs: 60_000 * 5,
    retry: {
      retries: 5,
      factor: 2,
      minTimeout: 1_000,
      maxTimeout: 10_000,
    },
    permanentErrorSubstrings: [
      "permission denied",
      "not allowed",
      "invalid session",
      "401",
      "invalid api key",
      "unauthorized",
      "failed to create livekit frame-metadata worker",
    ],
  },
  methods: {
    promptTimeoutMs: 15_000,
    updateTimeoutMs: 30_000,
  },
  livekit: {
    inferenceServerIdentityPrefix: "inference-server-",
    roomOptions: {
      adaptiveStream: false,
      dynacast: false,
    },
    defaultVideoCodec: "h264",
    defaultMaxVideoBitrateBps: MAX_VIDEO_BITRATE_BPS,
    vp9MaxVideoBitrateBps: 3_000_000,
    /** Seeds the publisher's bandwidth estimate (a start bitrate, not a minimum). */
    minVideoBitrateBps: MIN_VIDEO_BITRATE_BPS,
    simulcastLowerLayersBitrateBps: SIMULCAST_LOWER_LAYERS_BPS,
    bweVideoShare: BWE_VIDEO_SHARE,
    defaultPublishFps: 30,
  },
  observability: {
    stallFpsThreshold: 0.5,
    statsDefaultIntervalMs: 1_000,
    statsMinIntervalMs: 500,
    telemetryReportIntervalMs: 10_000,
    telemetryUrl: "https://platform.decart.ai/api/v1/telemetry",
    telemetryMaxItemsPerReport: 120,
    /**
     * Thresholds for the derived in-session connection-quality signal
     * (see observability/connection-quality.ts). Tuned for a camera-up
     * real-time pipeline (~3–3.5 Mbps upstream, model fps ~25–30). All
     * values are tunable here so behaviour can change without code edits.
     */
    connectionQuality: {
      /** Rolling-window size used to smooth raw per-sample metrics. */
      windowSamples: 5,
      /**
       * Samples to wait before the bitrate dimensions count — the encoder
       * and BWE ramp for several seconds after connect, so early low
       * bitrate is not a slow network. RTT/loss/stall start scoring sooner.
       * `decart-try-on` waits 30 samples watching inbound bitrate alone.
       */
      warmupSamples: 8,
      /** Consecutive worse samples required before the level downgrades. */
      downgradeConsecutive: 5,
      /** Consecutive better samples required before the level upgrades (recover slow). */
      upgradeConsecutive: 5,
      /** Round-trip time bands (ms). Bands widen by relayExtraMs on TURN-relayed paths. */
      rtt: { goodMs: 150, fairMs: 300, poorMs: 500, relayExtraMs: 100 },
      /**
       * Mid-stream (steady-state) true glass-to-glass latency bands (ms) — the
       * real per-frame camera→display latency through the model, used for the
       * latency dimension *instead of* RTT when frame-metadata measurement is on.
       * Already includes both network legs, so relayExtraMs does not apply.
       * Excludes startup (see `ttff`). Anchored to Datadog
       * `rt.stream.pipeline_latency_ms` (server-side median ~285ms / p95 ~510ms)
       * plus network + jitter-buffer + decode headroom. Tune with real data.
       */
      glassToGlass: { goodMs: 500, fairMs: 900, poorMs: 1500 },
      /**
       * Time-to-first-frame bands (ms) — startup latency from connect to the
       * first rendered model frame. An order of magnitude larger than mid-stream
       * and judged separately (a slow first frame is a different problem from a
       * laggy steady state). ~4–5s is an acceptable ("fair") cold start today.
       */
      ttff: { goodMs: 4_000, fairMs: 6_000, poorMs: 10_000 },
      /** Fraction of outbound packets the server reports lost (0..1). */
      loss: { good: 0.001, fair: 0.01, poor: 0.05 },
      /** End-to-end frame drop ratio (0..1), when a frame identity is available. */
      g2gDrop: { good: 0.001, fair: 0.01, poor: 0.05 },
      /** Available upstream bandwidth bands (kbps). Chromium-only. */
      upstream: {
        goodKbps: estimateKbpsFor(MAX_VIDEO_BITRATE_BPS),
        fairKbps: estimateKbpsFor(MIN_VIDEO_BITRATE_BPS),
        poorKbps: estimateKbpsFor(MIN_VIDEO_BITRATE_BPS / 2),
      },
      /** Rendered (inbound) frames-per-second. */
      stall: { goodFps: 20, fairFps: 12, poorFps: 5 },
    },
  },
  /**
   * SDK-only preflight (see preflight.ts). Validates WebRTC reachability
   * (does UDP egress work / will the path need TURN) and latency via a
   * throwaway RTCPeerConnection — no backend session, no media server.
   */
  preflight: {
    /** Public STUN servers used to gather server-reflexive candidates. */
    defaultStunUrls: ["stun:stun.l.google.com:19302"],
    /** Abort candidate gathering after this long. */
    iceGatherTimeoutMs: 5_000,
    /** RTT bands (ms) for the preflight verdict. */
    rtt: { goodMs: 150, marginalMs: 300 },
    /**
     * Deep probe (`checkConnectivity({ deep: true, model })`): briefly opens a
     * real session with a synthetic source + frame-metadata measurement to get a
     * true glass-to-glass verdict, then tears it down. Costs a short GPU session.
     * The verdict reuses the in-session `connectionQuality` bands. Duration must
     * cover TTFF (~4–5s) + mid-stream warm-up (~2s) before steady-state samples
     * accrue; resolves early once `minSamples` exist.
     */
    active: { durationMs: 12_000, minSamples: 5 },
  },
} as const;
