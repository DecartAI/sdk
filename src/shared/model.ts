import { z } from "zod";
import { createModelNotFoundError } from "../utils/errors";

export const realtimeModels = z.union([
	z.literal("mirage"),
	z.literal("lucy_v2v_720p_rt"),
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

export const modelInputSchemas = {
	"lucy-pro-t2v": z.object({
		prompt: z.string(),
		seed: z.number().optional(),
		resolution: z.string().optional(),
		orientation: z.string().optional(),
	}),
	"lucy-pro-t2i": z.object({
		prompt: z.string(),
		seed: z.number().optional(),
		resolution: z.string().optional(),
		orientation: z.string().optional(),
	}),
	"lucy-pro-i2v": z.object({
		prompt: z.string(),
		data: fileInputSchema,
		seed: z.number().optional(),
		resolution: z.string().optional(),
	}),
	"lucy-dev-i2v": z.object({
		prompt: z.string(),
		data: fileInputSchema,
		seed: z.number().optional(),
		resolution: z.string().optional(),
	}),
	"lucy-pro-v2v": z.object({
		prompt: z.string(),
		data: fileInputSchema,
		seed: z.number().optional(),
		resolution: z.string().optional(),
		enhance_prompt: z.boolean().optional(),
		num_inference_steps: z.number().optional(),
	}),
	"lucy-dev-v2v": z.object({
		prompt: z.string(),
		data: fileInputSchema,
		seed: z.number().optional(),
		resolution: z.string().optional(),
		enhance_prompt: z.boolean().optional(),
	}),
	"lucy-pro-flf2v": z.object({
		prompt: z.string(),
		start: fileInputSchema,
		end: fileInputSchema,
		seed: z.number().optional(),
		resolution: z.string().optional(),
	}),
	"lucy-pro-i2i": z.object({
		prompt: z.string(),
		data: fileInputSchema,
		seed: z.number().optional(),
		resolution: z.string().optional(),
		enhance_prompt: z.boolean().optional(),
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
		: z.ZodObject<any>;
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
		lucy_v2v_720p_rt: {
			urlPath: "/v1/stream",
			name: "lucy_v2v_720p_rt" as const,
			fps: 25,
			width: 1280,
			height: 704,
			inputSchema: z.object({}),
		},
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
	video: <T extends VideoModels>(model: T): ModelDefinition<T> => {
		const modelDefinition = _models.video[model];
		if (!modelDefinition) {
			throw createModelNotFoundError(model);
		}
		return modelDefinition as ModelDefinition<T>;
	},
	image: <T extends ImageModels>(model: T): ModelDefinition<T> => {
		const modelDefinition = _models.image[model];
		if (!modelDefinition) {
			throw createModelNotFoundError(model);
		}
		return modelDefinition as ModelDefinition<T>;
	},
};
