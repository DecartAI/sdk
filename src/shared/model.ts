import { z } from "zod";
import { createModelNotFoundError } from "../utils/errors";

export const realtimeModels = z.union([
	z.literal("mirage"),
	z.literal("mirage_v2"),
	z.literal("lucy_v2v_720p_rt"),
	z.literal("rt_test_2"),
]);
export const videoModels = z.union([
	z.literal("lucy-dev-i2v"),
	z.literal("lucy-dev-v2v"),
	z.literal("lucy-pro-t2v"),
	z.literal("lucy-pro-i2v"),
	z.literal("lucy-pro-v2v"),
	z.literal("lucy-pro-flf2v"),
]);
export const imageModels = z.union([
	z.literal("lucy-pro-t2i"),
	z.literal("lucy-pro-i2i"),
]);

export const modelSchema = z.union([realtimeModels, videoModels, imageModels]);
export type Model = z.infer<typeof modelSchema>;

export type RealTimeModels = z.infer<typeof realtimeModels>;
export type VideoModels = z.infer<typeof videoModels>;
export type ImageModels = z.infer<typeof imageModels>;

const fileInputSchema = z.union([
	z.instanceof(File),
	z.instanceof(Blob),
	z.instanceof(ReadableStream),
	z.instanceof(URL),
	z.url(),
]);

/**
 * Resolution schema for dev models. Supports only 720p.
 */
const devResolutionSchema = z
	.literal("720p")
	.default("720p")
	.optional()
	.describe(
		"The resolution to use for the generation. For dev models, only `720p` is supported.",
	);

/**
 * Resolution schema for pro models.
 * @param defaultValue - Optional default value (e.g., "720p")
 */
const proResolutionSchema = () => {
	return z
		.enum(["720p", "480p"])
		.optional()
		.describe("The resolution to use for the generation")
		.default("720p");
};

/**
 * Resolution schema for lucy-pro-v2v (supports 720p and 480p).
 */
const proV2vResolutionSchema = z
	.enum(["720p", "480p"])
	.optional()
	.describe("The resolution to use for the generation")
	.default("720p");

export const modelInputSchemas = {
	"lucy-pro-t2v": z.object({
		prompt: z.string().describe("The prompt to use for the generation"),
		seed: z.number().optional().describe("The seed to use for the generation"),
		resolution: proResolutionSchema(),
		orientation: z
			.string()
			.optional()
			.describe("The orientation to use for the generation"),
	}),
	"lucy-pro-t2i": z.object({
		prompt: z.string().describe("The prompt to use for the generation"),
		seed: z.number().optional().describe("The seed to use for the generation"),
		resolution: proResolutionSchema(),
		orientation: z
			.string()
			.optional()
			.describe("The orientation to use for the generation"),
	}),
	"lucy-pro-i2v": z.object({
		prompt: z.string().describe("The prompt to use for the generation"),
		data: fileInputSchema.describe(
			"The image data to use for generation (File, Blob, ReadableStream, URL, or string URL)",
		),
		seed: z.number().optional().describe("The seed to use for the generation"),
		resolution: proResolutionSchema(),
	}),
	"lucy-dev-i2v": z.object({
		prompt: z.string().describe("The prompt to use for the generation"),
		data: fileInputSchema.describe(
			"The image data to use for generation (File, Blob, ReadableStream, URL, or string URL)",
		),
		seed: z.number().optional().describe("The seed to use for the generation"),
		resolution: devResolutionSchema,
	}),
	"lucy-pro-v2v": z.object({
		prompt: z.string().describe("The prompt to use for the generation"),
		data: fileInputSchema.describe(
			"The video data to use for generation (File, Blob, ReadableStream, URL, or string URL)",
		),
		seed: z.number().optional().describe("The seed to use for the generation"),
		resolution: proV2vResolutionSchema,
		enhance_prompt: z
			.boolean()
			.optional()
			.describe("Whether to enhance the prompt"),
		num_inference_steps: z
			.number()
			.optional()
			.describe("The number of inference steps"),
	}),
	"lucy-dev-v2v": z.object({
		prompt: z.string().describe("The prompt to use for the generation"),
		data: fileInputSchema.describe(
			"The video data to use for generation (File, Blob, ReadableStream, URL, or string URL)",
		),
		seed: z.number().optional().describe("The seed to use for the generation"),
		resolution: devResolutionSchema,
		enhance_prompt: z
			.boolean()
			.optional()
			.describe("Whether to enhance the prompt"),
	}),
	"lucy-pro-flf2v": z.object({
		prompt: z.string().describe("The prompt to use for the generation"),
		start: fileInputSchema.describe(
			"The start frame image (File, Blob, ReadableStream, URL, or string URL)",
		),
		end: fileInputSchema.describe(
			"The end frame image (File, Blob, ReadableStream, URL, or string URL)",
		),
		seed: z.number().optional().describe("The seed to use for the generation"),
		resolution: proResolutionSchema(),
	}),
	"lucy-pro-i2i": z.object({
		prompt: z.string().describe("The prompt to use for the generation"),
		data: fileInputSchema.describe(
			"The image data to use for generation (File, Blob, ReadableStream, URL, or string URL)",
		),
		seed: z.number().optional().describe("The seed to use for the generation"),
		resolution: proResolutionSchema(),
		enhance_prompt: z
			.boolean()
			.optional()
			.describe("Whether to enhance the prompt"),
	}),
} as const;

export type ModelInputSchemas = typeof modelInputSchemas;

export type ModelDefinition<T extends Model = Model> = {
	name: T;
	urlPath: string;
	fps: number;
	width: number;
	height: number;
	inputSchema: T extends keyof ModelInputSchemas
		? ModelInputSchemas[T]
		: z.ZodTypeAny;
};

export const modelDefinitionSchema = z.object({
	name: modelSchema,
	urlPath: z.string(),
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
		rt_test_2: {
			urlPath: "/v1/stream",
                        name: "rt_test_2" as const,
                        fps: 25,
                        width: 1280,
                        height: 704,
                        inputSchema: z.object({}),
		}
	},
	image: {
		"lucy-pro-t2i": {
			urlPath: "/v1/generate/lucy-pro-t2i",
			name: "lucy-pro-t2i" as const,
			fps: 25,
			width: 1280,
			height: 704,
			inputSchema: modelInputSchemas["lucy-pro-t2i"],
		},
		"lucy-pro-i2i": {
			urlPath: "/v1/generate/lucy-pro-i2i",
			name: "lucy-pro-i2i" as const,
			fps: 25,
			width: 1280,
			height: 704,
			inputSchema: modelInputSchemas["lucy-pro-i2i"],
		},
	},
	video: {
		"lucy-dev-i2v": {
			urlPath: "/v1/generate/lucy-dev-i2v",
			name: "lucy-dev-i2v" as const,
			fps: 25,
			width: 1280,
			height: 704,
			inputSchema: modelInputSchemas["lucy-dev-i2v"],
		},
		"lucy-dev-v2v": {
			urlPath: "/v1/generate/lucy-dev-v2v",
			name: "lucy-dev-v2v" as const,
			fps: 25,
			width: 1280,
			height: 704,
			inputSchema: modelInputSchemas["lucy-dev-v2v"],
		},
		"lucy-pro-t2v": {
			urlPath: "/v1/generate/lucy-pro-t2v",
			name: "lucy-pro-t2v" as const,
			fps: 25,
			width: 1280,
			height: 704,
			inputSchema: modelInputSchemas["lucy-pro-t2v"],
		},
		"lucy-pro-i2v": {
			urlPath: "/v1/generate/lucy-pro-i2v",
			name: "lucy-pro-i2v" as const,
			fps: 25,
			width: 1280,
			height: 704,
			inputSchema: modelInputSchemas["lucy-pro-i2v"],
		},
		"lucy-pro-v2v": {
			urlPath: "/v1/generate/lucy-pro-v2v",
			name: "lucy-pro-v2v" as const,
			fps: 25,
			width: 1280,
			height: 704,
			inputSchema: modelInputSchemas["lucy-pro-v2v"],
		},
		"lucy-pro-flf2v": {
			urlPath: "/v1/generate/lucy-pro-flf2v",
			name: "lucy-pro-flf2v" as const,
			fps: 25,
			width: 1280,
			height: 704,
			inputSchema: modelInputSchemas["lucy-pro-flf2v"],
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
	 *   - `"lucy-pro-t2v"` - Text-to-video
	 *   - `"lucy-pro-i2v"` - Image-to-video
	 *   - `"lucy-pro-v2v"` - Video-to-video
	 *   - `"lucy-pro-flf2v"` - First-last-frame-to-video
	 * 	 - `"lucy-dev-i2v"` - Image-to-video (Dev quality)
	 *   - `"lucy-dev-v2v"` - Video-to-video (Dev quality)
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
	 *   - `"lucy-pro-t2i"` - Text-to-image
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
