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

export const modelDefinitionSchema = z.object({
	name: modelSchema,
	urlPath: z.string().optional(),
	fps: z.number().min(1),
	width: z.number().min(1),
	height: z.number().min(1),
});
export type ModelDefinition = z.infer<typeof modelDefinitionSchema>;

const _models = {
	realtime: {
		mirage: {
			urlPath: "/v1/stream",
			name: "mirage",
			fps: 25,
			width: 1280,
			height: 704,
		},
		lucy_v2v_720p_rt: {
			urlPath: "/v1/stream",
			name: "lucy_v2v_720p_rt",
			fps: 25,
			width: 1280,
			height: 704,
		},
	} satisfies Record<RealTimeModels, ModelDefinition>,
	image: {
		"lucy-pro-t2i": {
			urlPath: "/v1/generate/lucy-pro-t2i",
			name: "lucy-pro-t2i",
			fps: 25,
			width: 1280,
			height: 704,
		},
		"lucy-pro-i2i": {
			urlPath: "/v1/generate/lucy-pro-i2i",
			name: "lucy-pro-i2i",
			fps: 25,
			width: 1280,
			height: 704,
		},
	} satisfies Record<ImageModels, ModelDefinition>,
	video: {
		"lucy-dev-i2v": {
			urlPath: "/v1/generate/lucy-dev-i2v",
			name: "lucy-dev-i2v",
			fps: 25,
			width: 1280,
			height: 704,
		},
		"lucy-dev-v2v": {
			urlPath: "/v1/generate/lucy-dev-v2v",
			name: "lucy-dev-v2v",
			fps: 25,
			width: 1280,
			height: 704,
		},
		"lucy-pro-t2v": {
			urlPath: "/v1/generate/lucy-pro-t2v",
			name: "lucy-pro-t2v",
			fps: 25,
			width: 1280,
			height: 704,
		},
		"lucy-pro-i2v": {
			urlPath: "/v1/generate/lucy-pro-i2v",
			name: "lucy-pro-i2v",
			fps: 25,
			width: 1280,
			height: 704,
		},
		"lucy-pro-v2v": {
			urlPath: "/v1/generate/lucy-pro-v2v",
			name: "lucy-pro-v2v",
			fps: 25,
			width: 1280,
			height: 704,
		},
		"lucy-pro-flf2v": {
			urlPath: "/v1/generate/lucy-pro-flf2v",
			name: "lucy-pro-flf2v",
			fps: 25,
			width: 1280,
			height: 704,
		},
	} satisfies Record<VideoModels, ModelDefinition>,
} as const;

export const models = {
	realtime: (model: RealTimeModels): ModelDefinition => {
		const modelDefinition = _models.realtime[model];
		if (!modelDefinition) {
			throw createModelNotFoundError(model);
		}
		return modelDefinition;
	},
	video: (model: VideoModels): ModelDefinition => {
		const modelDefinition = _models.video[model];
		if (!modelDefinition) {
			throw createModelNotFoundError(model);
		}
		return modelDefinition;
	},
	image: (model: ImageModels): ModelDefinition => {
		const modelDefinition = _models.image[model];
		if (!modelDefinition) {
			throw createModelNotFoundError(model);
		}
		return modelDefinition;
	},
};
