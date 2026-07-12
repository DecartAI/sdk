import type { CustomModelDefinition, ModelDefinition } from "../shared/model";
import type { Logger } from "../utils/logger";
import type { RealTimeClient, RealTimeClientConnectOptions } from "./client";
import type { ConnectionQuality } from "./observability/connection-quality";

export type ConnectivityTransport = "udp" | "relay" | "failed";

export type ConnectivityMetrics = {
  transport: ConnectivityTransport;
  rttMs: number | null;
  g2gMs?: number | null;
  ttffMs?: number | null;
  g2gDropRatio?: number | null;
  upstreamJitterMs?: number | null;
  packetLoss?: number | null;
  sampleCount?: number;
};

export type ConnectivityReport = {
  quality: ConnectionQuality;
  metrics: ConnectivityMetrics;
  reasons: string[];
};

export type CheckConnectivityOptions = {
  iceServers?: RTCIceServer[];
  iceGatherTimeoutMs?: number;
  signal?: AbortSignal;
  deep?: boolean;
  model?: ModelDefinition | CustomModelDefinition;
  durationMs?: number;
};

export type RealtimeConnect = (
  stream: MediaStream | null,
  options: RealTimeClientConnectOptions,
) => Promise<RealTimeClient>;

export type PreflightOptions = {
  logger: Logger;
  connect?: RealtimeConnect;
};

export type PreflightRttThresholds = { goodMs: number; marginalMs: number };
