import { z } from "zod";
import { modelDefinitionSchema } from "../shared/model";
import { modelStateSchema } from "../shared/types";

export const processOptionsSchema = modelStateSchema.extend({
	model: modelDefinitionSchema,
	signal: z.instanceof(AbortSignal).optional(),
});
export type ProcessOptions = z.input<typeof processOptionsSchema>;

export type FileInput = File | Blob | ReadableStream | URL | string;
