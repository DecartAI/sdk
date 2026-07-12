import { createRealTimeClient, type RealTimeClientConnectOptions } from "../client";
import type { CreateRealtime } from "../factory";
import { createRealTimeSubscribeClient } from "../subscribe-client";
import { createReactNativePreflight } from "./preflight";
import {
  assertReactNativeReady,
  prepareReactNativeConnection,
  unsupportedReactNativeFeature,
} from "./prepare-connection";

export const createReactNativeRealtime: CreateRealtime = (options) => {
  const publish = createRealTimeClient({
    baseUrl: options.publishBaseUrl,
    apiKey: options.apiKey,
    integration: options.integration,
    logger: options.logger,
    telemetryEnabled: options.telemetryEnabled,
    prepareConnection: prepareReactNativeConnection,
  });
  const subscribe = createRealTimeSubscribeClient({
    baseUrl: options.subscribeBaseUrl,
    apiKey: options.apiKey,
    integration: options.integration,
    logger: options.logger,
  });
  const preflight = createReactNativePreflight({ logger: options.logger });

  return {
    connect: (stream, connectOptions) =>
      publish.connect(stream as MediaStream | null, connectOptions as unknown as RealTimeClientConnectOptions),
    subscribe: (subscribeOptions) => {
      assertReactNativeReady();
      return subscribe.subscribe(subscribeOptions);
    },
    checkConnectivity: async (checkOptions = {}) => {
      assertReactNativeReady();
      if (checkOptions.deep) unsupportedReactNativeFeature("Deep connectivity preflight");
      return preflight.checkConnectivity(checkOptions);
    },
  };
};
