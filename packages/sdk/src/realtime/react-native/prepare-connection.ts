import { createReactNativeSetupRequiredError, createUnsupportedPlatformFeatureError } from "../../utils/errors";
import { missingReactNativeRealtimeGlobals } from "../../utils/platform";
import type { PrepareConnection } from "../client";
import { createLiveKitMediaChannel } from "../media-channel";
import { RealtimeObservability } from "../observability/realtime-observability";

export function assertReactNativeReady(): void {
  const missing = missingReactNativeRealtimeGlobals();
  if (missing.length > 0) throw createReactNativeSetupRequiredError(missing);
}

export function unsupportedReactNativeFeature(feature: string): never {
  throw createUnsupportedPlatformFeatureError(feature, "React Native");
}

export const prepareReactNativeConnection: PrepareConnection = ({
  stream,
  mirror,
  debugQuality,
  preferredVideoCodec,
  observability: observabilityOptions,
}) => {
  assertReactNativeReady();
  if (mirror !== false) unsupportedReactNativeFeature("Outgoing video mirroring");
  if (debugQuality) unsupportedReactNativeFeature("debugQuality");

  return {
    stream: stream ?? new MediaStream(),
    observability: new RealtimeObservability(observabilityOptions),
    videoCodec: preferredVideoCodec,
    createMediaChannel: createLiveKitMediaChannel,
    dispose: () => {},
  };
};
