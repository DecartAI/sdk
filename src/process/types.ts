import { z } from "zod";
import { modelDefinitionSchema } from "../shared/model";

export const processOptionsSchema = z.object({
	model: modelDefinitionSchema,
	prompt: z.string().optional(),
	file: z.any().optional(),
	start: z.any().optional(),
	end: z.any().optional(),
	signal: z.instanceof(AbortSignal).optional(),
});
export type ProcessOptions = z.input<typeof processOptionsSchema>;

export type FileInput = File | Blob | ReadableStream | URL | string;
