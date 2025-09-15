import { z } from "zod";
import { createModelNotFoundError } from "../utils/errors";

export const modelSchema = z.union([
	z.literal("decart-v2v-v2.0-448p"),
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
	v2v: {
		"decart-v2v-v2.0-448p": {
			urlPath: "",
			name: "decart-v2v-v2.0-448p",
			fps: 27,
			width: 1280,
			height: 720,
		},
	} satisfies Record<Model, ModelDefinition>,
} as const;

export const models = {
	v2v: (model: Model): ModelDefinition => {
		const modelDefinition = _models.v2v[model];
		if (!modelDefinition) {
			throw createModelNotFoundError(model);
		}
		return modelDefinition;
	},
};
