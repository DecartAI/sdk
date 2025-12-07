import type { z } from "zod";
import type {
	ImageModelDefinition,
	ImageModels,
	ModelDefinition,
	ModelInputSchemas,
	VideoModels,
} from "../shared/model";

export type FileInput = File | Blob | ReadableStream | URL | string;

export type InferModelInputs<T extends ModelDefinition> =
	T["name"] extends keyof ModelInputSchemas
		? z.input<ModelInputSchemas[T["name"]]>
		: Record<string, never>;

/**
 * Model-specific input documentation for image generation models.
 */
export interface ImageGenerationInputs {
	/**
	 * Text description to use for the generation.
	 *
	 * See our [Prompt Engineering](https://docs.platform.decart.ai/models/image/image-generation#prompt-engineering) guide for how to write prompt for Decart image models effectively.
	 */
	prompt: string;
}

/**
 * Model-specific input documentation for image editing models.
 */
export interface ImageEditingInputs {
	/**
	 * Text description of the changes to apply to the image.
	 *
	 * It's highly recommended to read our [Prompt Engineering for Edits](https://docs.platform.decart.ai/models/image/image-editing#prompt-engineering-for-edits) guide for how to write effective editing prompts.
	 */
	prompt: string;
	/**
	 * The data to use for generation (for image-to-image).
	 * Can be a File, Blob, ReadableStream, URL, or string URL.
	 */
	data?: FileInput;
}

/**
 * Model-specific input documentation for video models.
 */
export interface VideoModelInputs {
	/**
	 * Text description to use for the generation.
	 *
	 * See our [Prompt Engineering](https://docs.platform.decart.ai/models/video/video-generation#prompt-engineering) guide for how to write prompt for Decart video models effectively.
	 */
	prompt: string;
	/**
	 * The data to use for generation (for image-to-video and video-to-video).
	 * Can be a File, Blob, ReadableStream, URL, or string URL.
	 *
	 * Output video is limited to 5 seconds.
	 */
	data?: FileInput;
}

/**
 * Default inputs for models that only require a prompt.
 */
export interface PromptInput {
	/**
	 * Text description to use for the generation.
	 */
	prompt: string;
}

/**
 * Conditional type that selects the appropriate model-specific input documentation based on the model type.
 * This allows different models to have field-specific documentation while maintaining type safety.
 * Specific models are checked first, then falls back to category-based selection.
 */
export type ModelSpecificInputs<T extends ModelDefinition> =
	T["name"] extends "lucy-pro-i2i"
		? ImageEditingInputs
		: T["name"] extends ImageModels
			? ImageGenerationInputs
			: T["name"] extends VideoModels
				? VideoModelInputs
				: PromptInput;

export interface ProcessInputs {
	/**
	 * Random seed for reproducible results.
	 *
	 * Using the same seed with the same prompt and settings will produce the same output every time.
	 * This is useful for testing, debugging, or when you want to recreate a specific result.
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
	 *
	 * @default "landscape"
	 */
	orientation?: "landscape" | "portrait";
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
	 * For best results, keep this `true` (default) to let Decart's AI enhance your prompts.
	 * Only disable it if you need exact prompt control.
	 *
	 * @default true
	 */
	enhance_prompt?: boolean;
	/**
	 * The number of inference steps.
	 *
	 * @default 50
	 */
	num_inference_steps?: number;
}

/**
 * ProcessInputs combined with model-specific inputs.
 * This ensures fields have the correct descriptions based on the model type.
 * Add fields to ImageGenerationInputs, ImageEditingInputs, VideoModelInputs, or PromptInput
 * to provide model-specific documentation for any field.
 */
type ModelSpecificProcessInputs<T extends ModelDefinition> = ProcessInputs &
	ModelSpecificInputs<T>;

/**
 * Pick only the fields from ModelSpecificProcessInputs that exist in the inferred model inputs,
 * so JSDoc comments will be preserved, while type inference will be accurate.
 */
type PickDocumentedInputs<T extends ModelDefinition> = Pick<
	ModelSpecificProcessInputs<T>,
	keyof ModelSpecificProcessInputs<T> & keyof InferModelInputs<T>
>;

/**
 * Merge documented inputs with inferred inputs, ensuring zod types take precedence
 * while preserving JSDoc comments from ModelSpecificProcessInputs.
 *
 * By intersecting PickDocumentedInputs with InferModelInputs, we get:
 * - JSDoc comments from ModelSpecificProcessInputs (from PickDocumentedInputs)
 * - Accurate types from zod schemas (from InferModelInputs, takes precedence in intersection)
 */
type MergeDocumentedInputs<T extends ModelDefinition> =
	PickDocumentedInputs<T> & InferModelInputs<T>;

/**
 * Options for the process client to generate image content.
 * Only image models support the sync/process API.
 *
 * @template T - The image model definition type
 */
export type ProcessOptions<
	T extends ImageModelDefinition = ImageModelDefinition,
> = {
	/**
	 * The model definition to use.
	 */
	model: T;
	/**
	 * Optional `AbortSignal` for canceling the request.
	 */
	signal?: AbortSignal;
} & MergeDocumentedInputs<T>;
