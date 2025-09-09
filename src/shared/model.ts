import { z } from "zod";
import { createModelNotFoundError } from "../utils/errors";

export const modelSchema = z.union([
	z.literal("decart-v2v-v1.0-432p"),
	z.literal("decart-v2v-v2.0-448p"),
	z.literal("decart-v2v-v2.0-704p"),
	z.literal("decart-v2v-v2.1-704p"),
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
		"decart-v2v-v1.0-432p": {
			urlPath: "",
			name: "decart-v2v-v1.0-432p",
			fps: 14,
			width: 768,
			height: 432,
		},
		"decart-v2v-v2.0-448p": {
			urlPath: "",
			name: "decart-v2v-v2.0-448p",
			fps: 23,
			width: 796,
			height: 448,
		},
		"decart-v2v-v2.0-704p": {
			urlPath: "",
			name: "decart-v2v-v2.0-704p",
			fps: 16,
			width: 1251,
			height: 704,
		},
		"decart-v2v-v2.1-704p": {
			urlPath: "",
			name: "decart-v2v-v2.1-704p",
			fps: 16,
			width: 1251,
			height: 704,
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
