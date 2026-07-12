import type * as LiveKitClient from "livekit-client";
import { createLiveKitInitializationError } from "../utils/errors";

export type LiveKitClientModule = typeof LiveKitClient;

let liveKitModulePromise: Promise<LiveKitClientModule> | undefined;

export function validateLiveKitModule(module: LiveKitClientModule): LiveKitClientModule {
  const invalid = [
    typeof module.Room !== "function" && "Room",
    (typeof module.RoomEvent !== "object" || module.RoomEvent === null) && "RoomEvent",
    (module.Track === null || (typeof module.Track !== "object" && typeof module.Track !== "function")) && "Track",
    (typeof module.ConnectionState !== "object" || module.ConnectionState === null) && "ConnectionState",
  ].filter((name): name is string => name !== false);
  if (invalid.length > 0) {
    throw createLiveKitInitializationError(
      `livekit-client is missing or has invalid required exports: ${invalid.join(", ")}`,
    );
  }
  return module;
}

/** Load the browser-neutral LiveKit client only when realtime is actually used. */
export function loadLiveKitClient(): Promise<LiveKitClientModule> {
  liveKitModulePromise ??= import("livekit-client").then(validateLiveKitModule).catch((error: unknown) => {
    liveKitModulePromise = undefined;
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "LIVEKIT_INITIALIZATION_ERROR"
    ) {
      throw error;
    }
    const cause = error instanceof Error ? error : new Error(String(error));
    throw createLiveKitInitializationError(`Failed to initialize livekit-client: ${cause.message}`, cause);
  });
  return liveKitModulePromise;
}
