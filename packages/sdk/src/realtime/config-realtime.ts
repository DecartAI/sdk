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
    defaultMaxVideoBitrateBps: 3_500_000,
    defaultPublishFps: 30,
  },
  observability: {
    stallFpsThreshold: 0.5,
    statsDefaultIntervalMs: 1_000,
    statsMinIntervalMs: 500,
    telemetryReportIntervalMs: 10_000,
    telemetryUrl: "https://platform.decart.ai/api/v1/telemetry",
    telemetryMaxItemsPerReport: 120,
  },
} as const;
