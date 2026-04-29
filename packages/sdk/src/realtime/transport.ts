import { z } from "zod";
import { detectPlatform, type Platform } from "../utils/platform";

export const transportOptionsSchema = z.object({
  platform: z.enum(["mobile", "desktop"]).optional(),
  codec: z.enum(["h264", "vp9", "av1"]).optional(),
  maxBitrateKbps: z.number().positive().optional(),
});

export type TransportOptions = z.infer<typeof transportOptionsSchema>;

export type ResolvedTransport = {
  codec: "h264" | "vp9" | "av1";
  maxBitrateKbps: number;
  degradationPreference: "balanced" | "maintain-framerate" | "maintain-resolution";
};

const PRESETS: Record<Platform, ResolvedTransport> = {
  mobile: {
    codec: "h264",
    maxBitrateKbps: 2500,
    degradationPreference: "maintain-framerate",
  },
  desktop: {
    codec: "vp9",
    maxBitrateKbps: 4500,
    degradationPreference: "balanced",
  },
};

export function resolveTransport(opts?: TransportOptions): ResolvedTransport {
  const platform = opts?.platform ?? detectPlatform();
  const preset = PRESETS[platform];
  return {
    codec: opts?.codec ?? preset.codec,
    maxBitrateKbps: opts?.maxBitrateKbps ?? preset.maxBitrateKbps,
    degradationPreference: preset.degradationPreference,
  };
}
