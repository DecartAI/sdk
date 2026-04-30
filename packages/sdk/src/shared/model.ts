import { z } from "zod";
import { createModelNotFoundError } from "../utils/errors";

/**
 * Map of deprecated model names to their canonical replacements.
 * Old names still work but will log a deprecation warning.
 */
const MODEL_ALIASES: Record<string, string> = {
  mirage: "lucy-restyle",
  mirage_v2: "lucy-restyle-2",
  lucy_v2v_720p_rt: "lucy",
  live_avatar: "live-avatar",
  "lucy-pro-v2v": "lucy-clip",
  "lucy-restyle-v2v": "lucy-restyle-2",
  "lucy-pro-i2i": "lucy-image-2",
};

const _warnedAliases = new Set<string>();

/** @internal Test-only helper to reset deprecation warning tracking */
export function _resetDeprecationWarnings(): void {
  _warnedAliases.clear();
}

function warnDeprecated(model: string): void {
  const canonical = MODEL_ALIASES[model];
  if (canonical && !_warnedAliases.has(model)) {
    _warnedAliases.add(model);
    console.warn(
      `[Decart SDK] Model "${model}" is deprecated. Use "${canonical}" instead. See https://docs.platform.decart.ai/models for details.`,
    );
  }
}

export const realtimeModels = z.union([
  // Canonical names
  z.literal("lucy"),
  z.literal("lucy-2.1"),
  z.literal("lucy-2.1-vton"),
  z.literal("lucy-restyle"),
  z.literal("lucy-restyle-2"),
  z.literal("live-avatar"),
  // Latest aliases (server-side resolution)
  z.literal("lucy-latest"),
  z.literal("lucy-vton-latest"),
  z.literal("lucy-restyle-latest"),
  // Deprecated names (use canonical names above instead)
  z.literal("mirage"),
  z.literal("mirage_v2"),
  z.literal("lucy_v2v_720p_rt"),
  z.literal("live_avatar"),
]);
export const videoModels = z.union([
  // Canonical names
  z.literal("lucy-clip"),
  z.literal("lucy-2.1"),
  z.literal("lucy-2.1-vton"),
  z.literal("lucy-restyle-2"),
  z.literal("lucy-motion"),
  // Latest aliases (server-side resolution)
  z.literal("lucy-latest"),
  z.literal("lucy-vton-latest"),
  z.literal("lucy-restyle-latest"),
  z.literal("lucy-clip-latest"),
  z.literal("lucy-motion-latest"),
  // Deprecated names (use canonical names above instead)
  z.literal("lucy-pro-v2v"),
  z.literal("lucy-restyle-v2v"),
]);
export const imageModels = z.union([
  // Canonical name
  z.literal("lucy-image-2"),
  // Latest alias (server-side resolution)
  z.literal("lucy-image-latest"),
  // Deprecated name (use canonical name above instead)
  z.literal("lucy-pro-i2i"),
]);

export const modelSchema = z.union([realtimeModels, videoModels, imageModels]);
export type Model = z.infer<typeof modelSchema>;

export type RealTimeModels = z.infer<typeof realtimeModels>;
export type VideoModels = z.infer<typeof videoModels>;
export type ImageModels = z.infer<typeof imageModels>;

export function isRealtimeModel(model: string): model is RealTimeModels {
  return realtimeModels.safeParse(model).success;
}

export function isVideoModel(model: string): model is VideoModels {
  return videoModels.safeParse(model).success;
}

export function isImageModel(model: string): model is ImageModels {
  return imageModels.safeParse(model).success;
}

const fileInputSchema = z.union([
  z.instanceof(File),
  z.instanceof(Blob),
  z.instanceof(ReadableStream),
  z.instanceof(URL),
  z.url(),
  // React Native file object format
  z.object({
    uri: z.string(),
    type: z.string(),
    name: z.string(),
  }),
]);

/**
 * Resolution schema for pro models.
 * @param defaultValue - Optional default value (e.g., "720p")
 */
const proResolutionSchema = () => {
  return z.enum(["720p", "480p"]).optional().describe("The resolution to use for the generation").default("720p");
};

/**
 * Resolution schema for lucy-motion.
 */
const motionResolutionSchema = z
  .literal("720p")
  .default("720p")
  .optional()
  .describe("The resolution to use for the generation");

/**
 * Resolution schema for video-to-video models (supports 720p).
 */
const v2vResolutionSchema = z
  .literal("720p")
  .optional()
  .describe("The resolution to use for the generation")
  .default("720p");

const videoEditSchema = z.object({
  prompt: z.string().min(1).max(1000).describe("The prompt to use for the generation"),
  data: fileInputSchema.describe(
    "The video data to use for generation (File, Blob, ReadableStream, URL, or string URL). Output video is limited to 5 seconds.",
  ),
  reference_image: fileInputSchema
    .optional()
    .describe(
      "Optional reference image to guide what to add to the video (File, Blob, ReadableStream, URL, or string URL)",
    ),
  seed: z.number().optional().describe("The seed to use for the generation"),
  resolution: v2vResolutionSchema,
  enhance_prompt: z.boolean().optional().describe("Whether to enhance the prompt"),
});

const imageEditSchema = z.object({
  prompt: z.string().min(1).max(1000).describe("The prompt to use for the generation"),
  data: fileInputSchema.describe(
    "The image data to use for generation (File, Blob, ReadableStream, URL, or string URL)",
  ),
  reference_image: fileInputSchema
    .optional()
    .describe("Optional reference image to guide the edit (File, Blob, ReadableStream, URL, or string URL)"),
  seed: z.number().optional().describe("The seed to use for the generation"),
  resolution: proResolutionSchema(),
  enhance_prompt: z.boolean().optional().describe("Whether to enhance the prompt"),
});

const restyleSchema = z
  .object({
    prompt: z.string().min(1).max(1000).optional().describe("Text prompt for the video editing"),
    reference_image: fileInputSchema
      .optional()
      .describe("Reference image to transform into a prompt (File, Blob, ReadableStream, URL, or string URL)"),
    data: fileInputSchema.describe("Video file to process (File, Blob, ReadableStream, URL, or string URL)"),
    seed: z.number().optional().describe("Seed for the video generation"),
    resolution: v2vResolutionSchema,
    enhance_prompt: z
      .boolean()
      .optional()
      .describe("Whether to enhance the prompt (only valid with text prompt, defaults to true on backend)"),
  })
  .refine((data) => (data.prompt !== undefined) !== (data.reference_image !== undefined), {
    message: "Must provide either 'prompt' or 'reference_image', but not both",
  })
  .refine((data) => !(data.reference_image !== undefined && data.enhance_prompt !== undefined), {
    message: "'enhance_prompt' is only valid when using 'prompt', not 'reference_image'",
  });

const videoEdit2Schema = z.object({
  prompt: z
    .string()
    .max(1000)
    .describe("Text prompt for the video editing. Send an empty string if you want no text prompt."),
  reference_image: fileInputSchema
    .optional()
    .describe("Optional reference image to guide the edit (File, Blob, ReadableStream, URL, or string URL)"),
  data: fileInputSchema.describe("Video file to process (File, Blob, ReadableStream, URL, or string URL)"),
  seed: z.number().optional().describe("The seed to use for the generation"),
  resolution: v2vResolutionSchema,
  enhance_prompt: z.boolean().optional().describe("Whether to enhance the prompt"),
});

export const modelInputSchemas = {
  // Canonical names
  "lucy-clip": videoEditSchema,
  "lucy-image-2": imageEditSchema,
  "lucy-restyle-2": restyleSchema,
  "lucy-2.1": videoEdit2Schema,
  "lucy-2.1-vton": videoEdit2Schema,
  "lucy-motion": z.object({
    data: fileInputSchema.describe(
      "The image data to use for generation (File, Blob, ReadableStream, URL, or string URL). Output video is limited to 5 seconds.",
    ),
    trajectory: z
      .array(
        z.object({
          frame: z.number().min(0),
          x: z.number().min(0),
          y: z.number().min(0),
        }),
      )
      .min(2)
      .max(1000)
      .describe("The trajectory of the desired movement of the object in the image"),
    seed: z.number().optional().describe("The seed to use for the generation"),
    resolution: motionResolutionSchema,
  }),
  // Latest aliases (server-side resolution)
  "lucy-latest": videoEdit2Schema,
  "lucy-vton-latest": videoEdit2Schema,
  "lucy-restyle-latest": restyleSchema,
  "lucy-clip-latest": videoEditSchema,
  "lucy-motion-latest": z.object({
    data: fileInputSchema.describe(
      "The image data to use for generation (File, Blob, ReadableStream, URL, or string URL). Output video is limited to 5 seconds.",
    ),
    trajectory: z
      .array(
        z.object({
          frame: z.number().min(0),
          x: z.number().min(0),
          y: z.number().min(0),
        }),
      )
      .min(2)
      .max(1000)
      .describe("The trajectory of the desired movement of the object in the image"),
    seed: z.number().optional().describe("The seed to use for the generation"),
    resolution: motionResolutionSchema,
  }),
  "lucy-image-latest": imageEditSchema,
  // Deprecated names (kept for backward compatibility)
  "lucy-pro-v2v": videoEditSchema,
  "lucy-pro-i2i": imageEditSchema,
  "lucy-restyle-v2v": restyleSchema,
} as const;

export type ModelInputSchemas = typeof modelInputSchemas;

export type ModelDefinition<T extends Model = Model> = {
  name: T;
  urlPath: string;
  queueUrlPath?: string;
  fps: number;
  width: number;
  height: number;
  inputSchema: T extends keyof ModelInputSchemas ? ModelInputSchemas[T] : z.ZodTypeAny;
};

/**
 * A model definition with an arbitrary (non-registry) model name.
 * Use this when providing your own model configuration.
 */
export type CustomModelDefinition = Omit<ModelDefinition, "name" | "inputSchema"> & {
  name: string;
  inputSchema?: z.ZodTypeAny;
};

/**
 * Type alias for model definitions that support synchronous processing.
 * Only image models support the sync/process API.
 * Requires `queueUrlPath` to distinguish from realtime definitions of the same model name.
 */
export type ImageModelDefinition = ModelDefinition<ImageModels> & { queueUrlPath: string };

/**
 * Type alias for model definitions that support queue processing.
 * Only video models support the queue API.
 * Requires `queueUrlPath` to distinguish from realtime definitions of the same model name.
 */
export type VideoModelDefinition = ModelDefinition<VideoModels> & { queueUrlPath: string };

export const modelDefinitionSchema = z.object({
  name: z.string(),
  urlPath: z.string(),
  queueUrlPath: z.string().optional(),
  fps: z.number().min(1),
  width: z.number().min(1),
  height: z.number().min(1),
  inputSchema: z.any().optional(),
});

const _models = {
  realtime: {
    // Canonical names
    lucy: {
      urlPath: "/v1/stream",
      name: "lucy" as const,
      fps: 25,
      width: 1280,
      height: 704,
      inputSchema: z.object({}),
    },
    "lucy-2.1": {
      urlPath: "/v1/stream",
      name: "lucy-2.1" as const,
      fps: 20,
      width: 1088,
      height: 624,
      inputSchema: z.object({}),
    },
    "lucy-2.1-vton": {
      urlPath: "/v1/stream",
      name: "lucy-2.1-vton" as const,
      fps: 20,
      width: 1088,
      height: 624,
      inputSchema: z.object({}),
    },
    "lucy-restyle": {
      urlPath: "/v1/stream",
      name: "lucy-restyle" as const,
      fps: 25,
      width: 1280,
      height: 704,
      inputSchema: z.object({}),
    },
    "lucy-restyle-2": {
      urlPath: "/v1/stream",
      name: "lucy-restyle-2" as const,
      fps: 22,
      width: 1280,
      height: 704,
      inputSchema: z.object({}),
    },
    "live-avatar": {
      urlPath: "/v1/stream",
      name: "live-avatar" as const,
      fps: 25,
      width: 1280,
      height: 720,
      inputSchema: z.object({}),
    },
    // Latest aliases (server-side resolution)
    "lucy-latest": {
      urlPath: "/v1/stream",
      name: "lucy-latest" as const,
      fps: 20,
      width: 1088,
      height: 624,
      inputSchema: z.object({}),
    },
    "lucy-vton-latest": {
      urlPath: "/v1/stream",
      name: "lucy-vton-latest" as const,
      fps: 20,
      width: 1088,
      height: 624,
      inputSchema: z.object({}),
    },
    "lucy-restyle-latest": {
      urlPath: "/v1/stream",
      name: "lucy-restyle-latest" as const,
      fps: 22,
      width: 1280,
      height: 704,
      inputSchema: z.object({}),
    },
    // Deprecated names (use canonical names above instead)
    mirage: {
      urlPath: "/v1/stream",
      name: "mirage" as const,
      fps: 25,
      width: 1280,
      height: 704,
      inputSchema: z.object({}),
    },
    mirage_v2: {
      urlPath: "/v1/stream",
      name: "mirage_v2" as const,
      fps: 22,
      width: 1280,
      height: 704,
      inputSchema: z.object({}),
    },
    lucy_v2v_720p_rt: {
      urlPath: "/v1/stream",
      name: "lucy_v2v_720p_rt" as const,
      fps: 25,
      width: 1280,
      height: 704,
      inputSchema: z.object({}),
    },
    live_avatar: {
      urlPath: "/v1/stream",
      name: "live_avatar" as const,
      fps: 25,
      width: 1280,
      height: 720,
      inputSchema: z.object({}),
    },
  },
  image: {
    // Canonical name
    "lucy-image-2": {
      urlPath: "/v1/generate/lucy-image-2",
      queueUrlPath: "/v1/jobs/lucy-image-2",
      name: "lucy-image-2" as const,
      fps: 25,
      width: 1280,
      height: 704,
      inputSchema: modelInputSchemas["lucy-image-2"],
    },
    // Latest alias (server-side resolution)
    "lucy-image-latest": {
      urlPath: "/v1/generate/lucy-image-latest",
      queueUrlPath: "/v1/jobs/lucy-image-latest",
      name: "lucy-image-latest" as const,
      fps: 25,
      width: 1280,
      height: 704,
      inputSchema: modelInputSchemas["lucy-image-latest"],
    },
    // Deprecated name
    "lucy-pro-i2i": {
      urlPath: "/v1/generate/lucy-pro-i2i",
      queueUrlPath: "/v1/jobs/lucy-pro-i2i",
      name: "lucy-pro-i2i" as const,
      fps: 25,
      width: 1280,
      height: 704,
      inputSchema: modelInputSchemas["lucy-pro-i2i"],
    },
  },
  video: {
    // Canonical names
    "lucy-clip": {
      urlPath: "/v1/generate/lucy-clip",
      queueUrlPath: "/v1/jobs/lucy-clip",
      name: "lucy-clip" as const,
      fps: 25,
      width: 1280,
      height: 704,
      inputSchema: modelInputSchemas["lucy-clip"],
    },
    "lucy-2.1": {
      urlPath: "/v1/generate/lucy-2.1",
      queueUrlPath: "/v1/jobs/lucy-2.1",
      name: "lucy-2.1" as const,
      fps: 20,
      width: 1088,
      height: 624,
      inputSchema: modelInputSchemas["lucy-2.1"],
    },
    "lucy-2.1-vton": {
      urlPath: "/v1/generate/lucy-2.1-vton",
      queueUrlPath: "/v1/jobs/lucy-2.1-vton",
      name: "lucy-2.1-vton" as const,
      fps: 20,
      width: 1088,
      height: 624,
      inputSchema: modelInputSchemas["lucy-2.1-vton"],
    },
    "lucy-restyle-2": {
      urlPath: "/v1/generate/lucy-restyle-2",
      queueUrlPath: "/v1/jobs/lucy-restyle-2",
      name: "lucy-restyle-2" as const,
      fps: 22,
      width: 1280,
      height: 704,
      inputSchema: modelInputSchemas["lucy-restyle-2"],
    },
    "lucy-motion": {
      urlPath: "/v1/generate/lucy-motion",
      queueUrlPath: "/v1/jobs/lucy-motion",
      name: "lucy-motion" as const,
      fps: 25,
      width: 1280,
      height: 704,
      inputSchema: modelInputSchemas["lucy-motion"],
    },
    // Latest aliases (server-side resolution)
    "lucy-latest": {
      urlPath: "/v1/generate/lucy-latest",
      queueUrlPath: "/v1/jobs/lucy-latest",
      name: "lucy-latest" as const,
      fps: 20,
      width: 1088,
      height: 624,
      inputSchema: modelInputSchemas["lucy-latest"],
    },
    "lucy-vton-latest": {
      urlPath: "/v1/generate/lucy-vton-latest",
      queueUrlPath: "/v1/jobs/lucy-vton-latest",
      name: "lucy-vton-latest" as const,
      fps: 20,
      width: 1088,
      height: 624,
      inputSchema: modelInputSchemas["lucy-vton-latest"],
    },
    "lucy-restyle-latest": {
      urlPath: "/v1/generate/lucy-restyle-latest",
      queueUrlPath: "/v1/jobs/lucy-restyle-latest",
      name: "lucy-restyle-latest" as const,
      fps: 22,
      width: 1280,
      height: 704,
      inputSchema: modelInputSchemas["lucy-restyle-latest"],
    },
    "lucy-clip-latest": {
      urlPath: "/v1/generate/lucy-clip-latest",
      queueUrlPath: "/v1/jobs/lucy-clip-latest",
      name: "lucy-clip-latest" as const,
      fps: 25,
      width: 1280,
      height: 704,
      inputSchema: modelInputSchemas["lucy-clip-latest"],
    },
    "lucy-motion-latest": {
      urlPath: "/v1/generate/lucy-motion-latest",
      queueUrlPath: "/v1/jobs/lucy-motion-latest",
      name: "lucy-motion-latest" as const,
      fps: 25,
      width: 1280,
      height: 704,
      inputSchema: modelInputSchemas["lucy-motion-latest"],
    },
    // Deprecated names (use canonical names above instead)
    "lucy-pro-v2v": {
      urlPath: "/v1/generate/lucy-pro-v2v",
      queueUrlPath: "/v1/jobs/lucy-pro-v2v",
      name: "lucy-pro-v2v" as const,
      fps: 25,
      width: 1280,
      height: 704,
      inputSchema: modelInputSchemas["lucy-pro-v2v"],
    },
    "lucy-restyle-v2v": {
      urlPath: "/v1/generate/lucy-restyle-v2v",
      queueUrlPath: "/v1/jobs/lucy-restyle-v2v",
      name: "lucy-restyle-v2v" as const,
      fps: 22,
      width: 1280,
      height: 704,
      inputSchema: modelInputSchemas["lucy-restyle-v2v"],
    },
  },
} as const;

export const models = {
  /**
   * Get a realtime streaming model identifier.
   *
   * Available options:
   *   - `"lucy-2.1"` - Lucy 2.1 realtime video editing
   *   - `"lucy-2.1-vton"` - Lucy 2.1 virtual try-on
   *   - `"lucy-restyle-2"` - Realtime video restyling
   *   - `"lucy-restyle"` - Legacy realtime restyling
   *   - `"lucy"` - Legacy Lucy realtime
   *   - `"live-avatar"` - Live avatar
   */
  realtime: <T extends RealTimeModels>(model: T): ModelDefinition<T> => {
    warnDeprecated(model);
    const modelDefinition = _models.realtime[model];
    if (!modelDefinition) {
      throw createModelNotFoundError(model);
    }
    return modelDefinition as ModelDefinition<T>;
  },
  /**
   * Get a video model identifier.
   *
   * Available options:
   *   - `"lucy-clip"` - Video-to-video editing
   *   - `"lucy-2.1"` - Long-form video editing (Lucy 2.1)
   *   - `"lucy-2.1-vton"` - Virtual try-on video editing
   *   - `"lucy-restyle-2"` - Video restyling
   *   - `"lucy-motion"` - Motion generation
   */
  video: <T extends VideoModels>(model: T): ModelDefinition<T> & { queueUrlPath: string } => {
    warnDeprecated(model);
    const modelDefinition = _models.video[model];
    if (!modelDefinition) {
      throw createModelNotFoundError(model);
    }
    return modelDefinition as ModelDefinition<T> & { queueUrlPath: string };
  },
  /**
   * Get an image model identifier.
   *
   * Available options:
   *   - `"lucy-image-2"` - Image-to-image editing
   */
  image: <T extends ImageModels>(model: T): ModelDefinition<T> & { queueUrlPath: string } => {
    warnDeprecated(model);
    const modelDefinition = _models.image[model];
    if (!modelDefinition) {
      throw createModelNotFoundError(model);
    }
    return modelDefinition as ModelDefinition<T> & { queueUrlPath: string };
  },
};
