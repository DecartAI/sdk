import { REALTIME_CONFIG } from "../config-realtime";
import { classifyConnectivity, gatherIceCandidates } from "../preflight-connectivity";
import type { CheckConnectivityOptions, ConnectivityReport, PreflightOptions } from "../preflight-types";

export function createReactNativePreflight({ logger }: PreflightOptions): {
  checkConnectivity(options?: CheckConnectivityOptions): Promise<ConnectivityReport>;
} {
  return {
    checkConnectivity: async (options = {}) => {
      const iceServers = options.iceServers ?? REALTIME_CONFIG.preflight.defaultStunUrls.map((urls) => ({ urls }));
      const timeoutMs = options.iceGatherTimeoutMs ?? REALTIME_CONFIG.preflight.iceGatherTimeoutMs;
      const result = await gatherIceCandidates(iceServers, timeoutMs, options.signal, logger);
      return classifyConnectivity(result, REALTIME_CONFIG.preflight.rtt);
    },
  };
}
