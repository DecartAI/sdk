import type { z } from "zod";
import type {
	ImageModels,
	ModelDefinition,
	ModelInputSchemas,
	VideoModels,
} from "../shared/model";

export type FileInput = File | Blob | ReadableStream | URL | string;

type InferModelInputs<T extends ModelDefinition> =
	T["name"] extends keyof ModelInputSchemas
		? z.input<ModelInputSchemas[T["name"]]>
		: Record<string, never>;

/**
 * Model-specific input documentation for image models.
 */
interface ImageModelInputs {
	/**
	 * Text description to use for the generation.
	 *
	 * See our [Prompt Engineering](https://docs.platform.decart.ai/models/image/image-generation#prompt-engineering) guide for how to write prompt for Decart image models effectively.
	 */
	prompt: string;
}

/**
 * Model-specific input documentation for video models.
 */
interface VideoModelInputs {
	/**
	 * Text description to use for the generation.
	 *
	 * See our [Prompt Engineering](https://docs.platform.decart.ai/models/video/video-generation#prompt-engineering) guide for how to write prompt for Decart video models effectively.
	 */
	prompt: string;
}

/**
 * Default inputs for models that only require a prompt.
 */
interface PromptInput {
	/**
	 * Text description to use for the generation.
	 */
	prompt: string;
}

type ModelCategoryFor<T extends ModelDefinition> = T["name"] extends ImageModels
	? "image"
	: T["name"] extends VideoModels
		? "video"
		: "other";

type ModelInputsByCategory = {
	image: ImageModelInputs;
	video: VideoModelInputs;
	other: PromptInput;
};

/**
 * Conditional type that selects the appropriate model-specific input documentation based on the model type.
 * This allows different models to have field-specific documentation while maintaining type safety.
 */
type ModelSpecificInputs<T extends ModelDefinition> =
	ModelInputsByCategory[ModelCategoryFor<T>];

interface ProcessInputs {
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
 * Add fields to ImageModelInputs or VideoModelInputs to provide model-specific details.
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
} & MergeDocumentedInputs<T>;
