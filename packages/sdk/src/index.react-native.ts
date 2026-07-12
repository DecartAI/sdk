import { createDecartClientForPlatform } from "./create-client";
import { createReactNativeRealtime } from "./realtime/react-native";

export type { DecartClientOptions } from "./create-client";
export * from "./public-api";

export const createDecartClient = (options: import("./create-client").DecartClientOptions = {}) =>
  createDecartClientForPlatform(createReactNativeRealtime, options);
