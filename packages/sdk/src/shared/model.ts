import { z } from "zod";
import { createModelNotFoundError } from "../utils/errors";

export const realtimeModels = z.union([
  z.literal("mirage"),
  z.literal("mirage_v2"),
  z.literal("lucy_v2v_720p_rt"),
  z.literal("lucy_2_rt"),
  z.literal("live_avatar"),
]);
export const videoModels = z.union([
  z.literal("lucy-pro-v2v"),
  z.literal("lucy-motion"),
  z.literal("lucy-restyle-v2v"),
  z.literal("lucy-2-v2v"),
]);
export const imageModels = z.literal("lucy-pro-i2i");

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
 * Resolution schema for lucy-pro-v2v (supports 720p).
 */
const proV2vResolutionSchema = z
  .literal("720p")
  .optional()
  .describe("The resolution to use for the generation")
  .default("720p");

export const modelInputSchemas = {
  "lucy-pro-v2v": z.object({
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
    resolution: proV2vResolutionSchema,
    enhance_prompt: z.boolean().optional().describe("Whether to enhance the prompt"),
  }),
  "lucy-pro-i2i": z.object({
    prompt: z.string().min(1).max(1000).describe("The prompt to use for the generation"),
    data: fileInputSchema.describe(
      "The image data to use for generation (File, Blob, ReadableStream, URL, or string URL)",
    ),
    reference_image: fileInputSchema
      .optional()
      .describe(
        "Optional reference image to guide the edit (File, Blob, ReadableStream, URL, or string URL)",
      ),
    seed: z.number().optional().describe("The seed to use for the generation"),
    resolution: proResolutionSchema(),
    enhance_prompt: z.boolean().optional().describe("Whether to enhance the prompt"),
  }),
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
  "lucy-restyle-v2v": z
    .object({
      prompt: z.string().min(1).max(1000).optional().describe("Text prompt for the video editing"),
      reference_image: fileInputSchema
        .optional()
        .describe("Reference image to transform into a prompt (File, Blob, ReadableStream, URL, or string URL)"),
      data: fileInputSchema.describe("Video file to process (File, Blob, ReadableStream, URL, or string URL)"),
      seed: z.number().optional().describe("Seed for the video generation"),
      resolution: proV2vResolutionSchema,
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
    }),
  "lucy-2-v2v": z.object({
    prompt: z
      .string()
      .max(1000)
      .describe("Text prompt for the video editing. Send an empty string if you want no text prompt."),
    reference_image: fileInputSchema
      .optional()
      .describe("Optional reference image to guide the edit (File, Blob, ReadableStream, URL, or string URL)"),
    data: fileInputSchema.describe("Video file to process (File, Blob, ReadableStream, URL, or string URL)"),
    seed: z.number().optional().describe("The seed to use for the generation"),
    resolution: proV2vResolutionSchema,
    enhance_prompt: z.boolean().optional().describe("Whether to enhance the prompt"),
  }),
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
 */
export type ImageModelDefinition = ModelDefinition<ImageModels>;

/**
 * Type alias for model definitions that support queue processing.
 * Only video models support the queue API.
 */
export type VideoModelDefinition = ModelDefinition<VideoModels>;

export const modelDefinitionSchema = z.object({
  name: z.string(),
  urlPath: z.string(),
  queueUrlPath: z.string().optional(),
  fps: z.number().min(1),
  width: z.number().min(1),
  height: z.number().min(1),
  inputSchema: z.any(),
});

const _models = {
  realtime: {
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
    lucy_2_rt: {
      urlPath: "/v1/stream",
      name: "lucy_2_rt" as const,
      fps: 20,
      width: 1280,
      height: 720,
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
    "lucy-pro-v2v": {
      urlPath: "/v1/generate/lucy-pro-v2v",
      queueUrlPath: "/v1/jobs/lucy-pro-v2v",
      name: "lucy-pro-v2v" as const,
      fps: 25,
      width: 1280,
      height: 704,
      inputSchema: modelInputSchemas["lucy-pro-v2v"],
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
    "lucy-restyle-v2v": {
      urlPath: "/v1/generate/lucy-restyle-v2v",
      queueUrlPath: "/v1/jobs/lucy-restyle-v2v",
      name: "lucy-restyle-v2v" as const,
      fps: 22,
      width: 1280,
      height: 704,
      inputSchema: modelInputSchemas["lucy-restyle-v2v"],
    },
    "lucy-2-v2v": {
      urlPath: "/v1/generate/lucy-2-v2v",
      queueUrlPath: "/v1/jobs/lucy-2-v2v",
      name: "lucy-2-v2v" as const,
      fps: 20,
      width: 1280,
      height: 720,
      inputSchema: modelInputSchemas["lucy-2-v2v"],
    },
  },
} as const;

export const models = {
  realtime: <T extends RealTimeModels>(model: T): ModelDefinition<T> => {
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
   *   - `"lucy-pro-v2v"` - Video-to-video
   *   - `"lucy-restyle-v2v"` - Video-to-video (Restyling)
   *   - `"lucy-2-v2v"` - Video-to-video (Long-form editing, 720p)
   *   - `"lucy-motion"` - Motion generation
   */
  video: <T extends VideoModels>(model: T): ModelDefinition<T> => {
    const modelDefinition = _models.video[model];
    if (!modelDefinition) {
      throw createModelNotFoundError(model);
    }
    return modelDefinition as ModelDefinition<T>;
  },
  /**
   * Get an image model identifier.
   *
   * Available options:
   *   - `"lucy-pro-i2i"` - Image-to-image
   */
  image: <T extends ImageModels>(model: T): ModelDefinition<T> => {
    const modelDefinition = _models.image[model];
    if (!modelDefinition) {
      throw createModelNotFoundError(model);
    }
    return modelDefinition as ModelDefinition<T>;
  },
};
