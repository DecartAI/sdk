import { createRealTimeClient, type RealTimeClientConnectOptions } from "../client";
import type { CreateRealtime } from "../factory";
import { createRealTimeSubscribeClient } from "../subscribe-client";
import { createPreflight } from "./preflight";
import { prepareBrowserConnection } from "./prepare-connection";

export const createBrowserRealtime: CreateRealtime = (options) => {
  const publish = createRealTimeClient({
    baseUrl: options.publishBaseUrl,
    apiKey: options.apiKey,
    integration: options.integration,
    logger: options.logger,
    telemetryEnabled: options.telemetryEnabled,
    prepareConnection: prepareBrowserConnection,
  });
  const subscribe = createRealTimeSubscribeClient({
    baseUrl: options.subscribeBaseUrl,
    apiKey: options.apiKey,
    integration: options.integration,
    logger: options.logger,
  });
  const preflight = createPreflight({ logger: options.logger, connect: publish.connect });

  return {
    connect: (stream, connectOptions) =>
      publish.connect(stream as MediaStream | null, connectOptions as unknown as RealTimeClientConnectOptions),
    subscribe: subscribe.subscribe,
    checkConnectivity: preflight.checkConnectivity,
  };
};
