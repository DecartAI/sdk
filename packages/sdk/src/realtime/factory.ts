import type { Logger } from "../utils/logger";
import type { RealTimeClient, RealTimeClientConnectOptions, RealtimeMediaStream } from "./client";
import type { CheckConnectivityOptions, ConnectivityReport } from "./preflight-types";
import type { RealTimeSubscribeClient, SubscribeOptions } from "./subscribe-client";

export type RealtimeFactoryOptions = {
  publishBaseUrl: string;
  subscribeBaseUrl: string;
  apiKey: string;
  integration?: string;
  logger: Logger;
  telemetryEnabled: boolean;
};

export type Realtime = {
  connect<TStream extends RealtimeMediaStream = MediaStream>(
    stream: TStream | null,
    options: RealTimeClientConnectOptions<TStream>,
  ): Promise<RealTimeClient>;
  subscribe(options: SubscribeOptions): Promise<RealTimeSubscribeClient>;
  checkConnectivity(options?: CheckConnectivityOptions): Promise<ConnectivityReport>;
};

export type CreateRealtime = (options: RealtimeFactoryOptions) => Realtime;
