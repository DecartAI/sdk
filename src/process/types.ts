import type { z } from "zod";
import type { ModelDefinition, ModelInputSchemas } from "../shared/model";

type InferModelInputs<T extends ModelDefinition> = T["name"] extends keyof ModelInputSchemas
	? z.input<ModelInputSchemas[T["name"]]>
	: Record<string, never>;

export type ProcessOptions<T extends ModelDefinition = ModelDefinition> = {
	model: T;
	signal?: AbortSignal;
} & InferModelInputs<T>;

export type FileInput = File | Blob | ReadableStream | URL | string;
