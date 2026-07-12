import { z } from "zod";
import { createModelNotFoundError } from "../utils/errors";
import { globalInstanceSchema } from "../utils/runtime";

const CANONICAL_MODEL_NAMES = [
  "lucy-2.1",
  "lucy-2.5",
  "lucy-vton-2",
  "lucy-vton-3",
  "lucy-restyle-2",
  "lucy-clip",
  "lucy-image-2",
] as const;

const CANONICAL_REALTIME_MODEL_NAMES = [
  "lucy-2.1",
  "lucy-2.5",
  "lucy-vton-2",
  "lucy-vton-3",
  "lucy-restyle-2",
] as const;
const CANONICAL_VIDEO_MODEL_NAMES = [
  "lucy-clip",
  "lucy-2.1",
  "lucy-2.5",
  "lucy-vton-2",
  "lucy-vton-3",
  "lucy-restyle-2",
] as const;
const CANONICAL_IMAGE_MODEL_NAMES = ["lucy-image-2"] as const;

export const canonicalRealtimeModels = z.enum(CANONICAL_REALTIME_MODEL_NAMES);
export const canonicalVideoModels = z.enum(CANONICAL_VIDEO_MODEL_NAMES);
export const canonicalImageModels = z.enum(CANONICAL_IMAGE_MODEL_NAMES);
export const canonicalModelSchema = z.enum(CANONICAL_MODEL_NAMES);
export type CanonicalModel = z.infer<typeof canonicalModelSchema>;

/**
 * Map of deprecated model names to their canonical replacements.
 * Old names still work but will log a deprecation warning.
 */
export const modelAliases = {
  "lucy-2.1-vton-2": "lucy-vton-2",
  "lucy-pro-v2v": "lucy-clip",
  "lucy-restyle-v2v": "lucy-restyle-2",
  "lucy-pro-i2i": "lucy-image-2",
} as const satisfies Record<string, CanonicalModel>;

const _warnedAliases = new Set<string>();

/** @internal Test-only helper to reset deprecation warning tracking */
export function _resetDeprecationWarnings(): void {
  _warnedAliases.clear();
}

function warnDeprecated(model: string): void {
  const canonical = modelAliases[model as keyof typeof modelAliases];
  if (canonical && !_warnedAliases.has(model)) {
    _warnedAliases.add(model);
    console.warn(
      `[Decart SDK] Model "${model}" is deprecated. Use "${canonical}" instead. See https://docs.platform.decart.ai/models for details.`,
    );
  }
}

export const realtimeModels = z.union([
  // Canonical names
  z.literal("lucy-2.1"),
  z.literal("lucy-2.5"),
  z.literal("lucy-vton-2"),
  z.literal("lucy-vton-3"),
  z.literal("lucy-restyle-2"),
  // Latest aliases (server-side resolution)
  z.literal("lucy-latest"),
  z.literal("lucy-vton-latest"),
  z.literal("lucy-restyle-latest"),
  // Deprecated names (use canonical names above instead)
  z.literal("lucy-2.1-vton-2"),
]);
export const videoModels = z.union([
  // Canonical names
  z.literal("lucy-clip"),
  z.literal("lucy-2.1"),
  z.literal("lucy-2.5"),
  z.literal("lucy-vton-2"),
  z.literal("lucy-vton-3"),
  z.literal("lucy-restyle-2"),
  // Latest aliases (server-side resolution)
  z.literal("lucy-latest"),
  z.literal("lucy-vton-latest"),
  z.literal("lucy-restyle-latest"),
  z.literal("lucy-clip-latest"),
  // Deprecated names (use canonical names above instead)
  z.literal("lucy-2.1-vton-2"),
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

export function isModel(model: string): model is Model {
  return modelSchema.safeParse(model).success;
}

export function isCanonicalModel(model: string): model is CanonicalModel {
  return canonicalModelSchema.safeParse(model).success;
}

/**
 * Resolve deprecated aliases to canonical model names and pass accepted model names through unchanged.
 * Latest aliases pass through unchanged because they are server-side moving targets. This is a pure normalization helper
 * and does not emit deprecation warnings.
 */
export function resolveModelAlias(model: string): Model | undefined {
  const canonical = modelAliases[model as keyof typeof modelAliases];
  if (canonical) {
    return canonical;
  }

  const parsedModel = modelSchema.safeParse(model);
  return parsedModel.success ? parsedModel.data : undefined;
}

/**
 * Resolve deprecated aliases and canonical inputs to stable canonical model names.
 * Latest aliases are server-side moving targets, so they intentionally return undefined. This is a pure normalization
 * helper and does not emit deprecation warnings.
 */
export function resolveCanonicalModelAlias(model: string): CanonicalModel | undefined {
  const canonical = modelAliases[model as keyof typeof modelAliases];
  if (canonical) {
    return canonical;
  }

  const parsedModel = canonicalModelSchema.safeParse(model);
  return parsedModel.success ? parsedModel.data : undefined;
}

const fileInputSchema = z.union([
  globalInstanceSchema<File>("File"),
  globalInstanceSchema<Blob>("Blob"),
  globalInstanceSchema<ReadableStream>("ReadableStream"),
  globalInstanceSchema<URL>("URL"),
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
 * Resolution schema for video-to-video models (supports 720p).
 */
const v2vResolutionSchema = z
  .literal("720p")
  .optional()
  .describe("The resolution to use for the generation")
  .default("720p");

const videoEditSchema = z.object({
  prompt: z.string().min(1).describe("The prompt to use for the generation"),
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
    prompt: z.string().min(1).optional().describe("Text prompt for the video editing"),
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
  prompt: z.string().describe("Text prompt for the video editing. Send an empty string if you want no text prompt."),
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
  "lucy-2.5": videoEdit2Schema,
  "lucy-vton-2": videoEdit2Schema,
  "lucy-vton-3": videoEdit2Schema,
  // Latest aliases (server-side resolution)
  "lucy-latest": videoEdit2Schema,
  "lucy-vton-latest": videoEdit2Schema,
  "lucy-restyle-latest": restyleSchema,
  "lucy-clip-latest": videoEditSchema,
  "lucy-image-latest": imageEditSchema,
  // Deprecated names (kept for backward compatibility)
  "lucy-2.1-vton-2": videoEdit2Schema,
  "lucy-pro-v2v": videoEditSchema,
  "lucy-pro-i2i": imageEditSchema,
  "lucy-restyle-v2v": restyleSchema,
} as const;

export type ModelInputSchemas = typeof modelInputSchemas;

export type ModelFps = number | { max?: number; min?: number; ideal?: number; exact?: number };

export type ModelDefinition<T extends Model = Model> = {
  name: T;
  urlPath: string;
  queueUrlPath?: string;
  fps: ModelFps;
  width: number;
  height: number;
  inputSchema: T extends keyof ModelInputSchemas ? ModelInputSchemas[T] : z.ZodTypeAny;
};

export function resolveFpsNumber(fps: ModelFps, fallback = 30): number {
  if (typeof fps === "number") return fps;
  return fps.ideal ?? fps.max ?? fps.exact ?? fps.min ?? fallback;
}

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
export type ImageModelDefinition = ModelDefinition<ImageModels> & { fps: number; queueUrlPath: string };

/**
 * Type alias for model definitions that support queue processing.
 * Only video models support the queue API.
 * Requires `queueUrlPath` to distinguish from realtime definitions of the same model name.
 */
export type VideoModelDefinition = ModelDefinition<VideoModels> & { fps: number; queueUrlPath: string };

export const modelDefinitionSchema = z.object({
  name: z.string(),
  urlPath: z.string(),
  queueUrlPath: z.string().optional(),
  fps: z.union([
    z.number().min(1),
    z.object({
      max: z.number().min(1).optional(),
      min: z.number().min(1).optional(),
      ideal: z.number().min(1).optional(),
      exact: z.number().min(1).optional(),
    }),
  ]),
  width: z.number().min(1),
  height: z.number().min(1),
  inputSchema: z.any().optional(),
});

const _models = {
  realtime: {
    // Canonical names
    "lucy-2.1": {
      urlPath: "/v1/stream",
      name: "lucy-2.1" as const,
      fps: { ideal: 30, max: 30 },
      width: 1088,
      height: 624,
      inputSchema: z.object({}),
    },
    "lucy-2.5": {
      urlPath: "/v1/stream",
      name: "lucy-2.5" as const,
      fps: { ideal: 30, max: 30 },
      width: 1280,
      height: 720,
      inputSchema: z.object({}),
    },
    "lucy-vton-2": {
      urlPath: "/v1/stream",
      name: "lucy-vton-2" as const,
      fps: { ideal: 30, max: 30 },
      width: 1088,
      height: 624,
      inputSchema: z.object({}),
    },
    "lucy-vton-3": {
      urlPath: "/v1/stream",
      name: "lucy-vton-3" as const,
      fps: { ideal: 30, max: 30 },
      width: 1088,
      height: 624,
      inputSchema: z.object({}),
    },
    "lucy-restyle-2": {
      urlPath: "/v1/stream",
      name: "lucy-restyle-2" as const,
      fps: { ideal: 30, max: 30 },
      width: 1280,
      height: 704,
      inputSchema: z.object({}),
    },
    // Latest aliases (server-side resolution)
    "lucy-latest": {
      urlPath: "/v1/stream",
      name: "lucy-latest" as const,
      fps: { ideal: 30, max: 30 },
      width: 1088,
      height: 624,
      inputSchema: z.object({}),
    },
    // Server-side alias currently resolves to lucy-vton-3.
    "lucy-vton-latest": {
      urlPath: "/v1/stream",
      name: "lucy-vton-latest" as const,
      fps: { ideal: 30, max: 30 },
      width: 1088,
      height: 624,
      inputSchema: z.object({}),
    },
    "lucy-restyle-latest": {
      urlPath: "/v1/stream",
      name: "lucy-restyle-latest" as const,
      fps: { ideal: 30, max: 30 },
      width: 1280,
      height: 704,
      inputSchema: z.object({}),
    },
    // Deprecated names (use canonical names above instead)
    "lucy-2.1-vton-2": {
      urlPath: "/v1/stream",
      name: "lucy-2.1-vton-2" as const,
      fps: { ideal: 30, max: 30 },
      width: 1088,
      height: 624,
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
    "lucy-2.5": {
      urlPath: "/v1/generate/lucy-2.5",
      queueUrlPath: "/v1/jobs/lucy-2.5",
      name: "lucy-2.5" as const,
      fps: 20,
      width: 1280,
      height: 720,
      inputSchema: modelInputSchemas["lucy-2.5"],
    },
    "lucy-vton-2": {
      urlPath: "/v1/generate/lucy-vton-2",
      queueUrlPath: "/v1/jobs/lucy-vton-2",
      name: "lucy-vton-2" as const,
      fps: 20,
      width: 1088,
      height: 624,
      inputSchema: modelInputSchemas["lucy-vton-2"],
    },
    "lucy-vton-3": {
      urlPath: "/v1/generate/lucy-vton-3",
      queueUrlPath: "/v1/jobs/lucy-vton-3",
      name: "lucy-vton-3" as const,
      fps: 20,
      width: 1088,
      height: 624,
      inputSchema: modelInputSchemas["lucy-vton-3"],
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
    // Server-side alias currently resolves to lucy-vton-3.
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
    // Deprecated names (use canonical names above instead)
    "lucy-2.1-vton-2": {
      urlPath: "/v1/generate/lucy-2.1-vton-2",
      queueUrlPath: "/v1/jobs/lucy-2.1-vton-2",
      name: "lucy-2.1-vton-2" as const,
      fps: 20,
      width: 1088,
      height: 624,
      inputSchema: modelInputSchemas["lucy-2.1-vton-2"],
    },
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

export type ModelKind = "realtime" | "video" | "image";
export type ListedModelDefinition = ModelDefinition & { kind: ModelKind };

const modelKinds = ["realtime", "video", "image"] as const satisfies readonly ModelKind[];
const canonicalSchemasByKind = {
  realtime: canonicalRealtimeModels,
  video: canonicalVideoModels,
  image: canonicalImageModels,
} as const;

/**
 * List SDK model definitions by kind.
 * When canonicalOnly is true, deprecated and latest aliases are excluded per kind. Models available in multiple kinds
 * are returned once per kind with the same name and different kind values.
 */
export function listModels(options: { kind?: ModelKind; canonicalOnly?: boolean } = {}): ListedModelDefinition[] {
  const kinds = options.kind ? [options.kind] : modelKinds;

  return kinds.flatMap((kind) => {
    return Object.values(_models[kind])
      .filter(
        (modelDefinition) =>
          !options.canonicalOnly || canonicalSchemasByKind[kind].safeParse(modelDefinition.name).success,
      )
      .map((modelDefinition) => ({ ...modelDefinition, kind }) as ListedModelDefinition);
  });
}

export const models = {
  /**
   * Get a realtime streaming model identifier.
   *
   * Available options:
   *   - `"lucy-2.1"` - Lucy 2.1 realtime video editing
   *   - `"lucy-2.5"` - Lucy 2.5 realtime video editing
   *   - `"lucy-vton-2"` - Lucy virtual try-on 2
   *   - `"lucy-vton-3"` - Lucy virtual try-on 3
   *   - `"lucy-restyle-2"` - Realtime video restyling
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
   *   - `"lucy-2.5"` - Long-form video editing (Lucy 2.5)
   *   - `"lucy-vton-2"` - Virtual try-on 2 video editing
   *   - `"lucy-vton-3"` - Virtual try-on 3 video editing
   *   - `"lucy-restyle-2"` - Video restyling
   */
  video: <T extends VideoModels>(model: T): ModelDefinition<T> & { fps: number; queueUrlPath: string } => {
    warnDeprecated(model);
    const modelDefinition = _models.video[model];
    if (!modelDefinition) {
      throw createModelNotFoundError(model);
    }
    return modelDefinition as ModelDefinition<T> & { fps: number; queueUrlPath: string };
  },
  /**
   * Get an image model identifier.
   *
   * Available options:
   *   - `"lucy-image-2"` - Image-to-image editing
   */
  image: <T extends ImageModels>(model: T): ModelDefinition<T> & { fps: number; queueUrlPath: string } => {
    warnDeprecated(model);
    const modelDefinition = _models.image[model];
    if (!modelDefinition) {
      throw createModelNotFoundError(model);
    }
    return modelDefinition as ModelDefinition<T> & { fps: number; queueUrlPath: string };
  },
};
