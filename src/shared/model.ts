import { z } from "zod";
import { createModelNotFoundError } from "../utils/errors";

export const modelSchema = z.union([
	z.literal("mirage"),
	z.literal("lucy_v2v_720p_rt"),
]);
export type Model = z.infer<typeof modelSchema>;

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
	} satisfies Record<Model, ModelDefinition>,
} as const;

export const models = {
	realtime: (model: Model): ModelDefinition => {
		const modelDefinition = _models.realtime[model];
		if (!modelDefinition) {
			throw createModelNotFoundError(model);
		}
		return modelDefinition;
	},
};
