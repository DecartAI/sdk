import type { z } from "zod";
import type { ModelDefinition, ModelInputSchemas } from "../shared/model";

export type FileInput = File | Blob | ReadableStream | URL | string;

type InferModelInputs<T extends ModelDefinition> =
	T["name"] extends keyof ModelInputSchemas
		? z.input<ModelInputSchemas[T["name"]]>
		: Record<string, never>;

interface ProcessInputs {
	/**
	 * Text description to use for the generation.
	 *
	 * See our [Prompt Engineering](https://docs.platform.decart.ai/models/image/image-generation#prompt-engineering) guide for how to write prompt for Decart models effectively.
	 */
	prompt: string;
	/**
	 * Random seed for reproducible results.
	 *
	 */
	seed?: number;
	/**
	 * The output resolution to use for the generation.
	 *
	 * @default "720p"
	 */
	resolution?: "480p" | "720p";
	/**
	 * The output orientation to use for the generation.
	 */
	orientation?: "landscape" | "portrait";
	/**
	 * The data to use for generation (for image-to-image and video-to-video).
	 * Can be a File, Blob, ReadableStream, URL, or string URL.
	 */
	data?: FileInput;
	/**
	 * The start frame image (for first-last-frame models).
	 * Can be a File, Blob, ReadableStream, URL, or string URL.
	 */
	start?: FileInput;
	/**
	 * The end frame image (for first-last-frame models).
	 * Can be a File, Blob, ReadableStream, URL, or string URL.
	 */
	end?: FileInput;
	/**
	 * Whether to enhance the prompt.
	 *
	 * @remarks
	 * For best results, keep this (default) to let Decart’s AI enhance your prompts. Only disable it if you need exact prompt control.
	 *
	 * @default true
	 */
	enhance_prompt?: boolean;
	/**
	 * The number of inference steps.
	 */
	num_inference_steps?: number;
}

/**
 * Options for the process client to generate video or image content.
 *
 * @template T - The model definition type
 */
export type ProcessOptions<T extends ModelDefinition = ModelDefinition> = {
	/**
	 * The model definition to use.
	 */
	model: T;
	/**
	 * Optional `AbortSignal` for canceling the request.
	 */
	signal?: AbortSignal;
} & ProcessInputs &
	InferModelInputs<T>;
