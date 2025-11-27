import type { z } from "zod";
import type {
	ImageModels,
	ModelDefinition,
	ModelInputSchemas,
	VideoModels,
} from "../shared/model";
import type { FileInput } from "../process/types";

/**
 * Job status values returned by the queue API.
 */
export type JobStatus = "pending" | "processing" | "completed" | "failed";

/**
 * Response from POST /v1/jobs/{model} - job submission.
 */
export type JobSubmitResponse = {
	job_id: string;
	status: JobStatus;
};

/**
 * Response from GET /v1/jobs/{job_id} - job status check.
 */
export type JobStatusResponse = {
	job_id: string;
	status: JobStatus;
};

/**
 * Result from submitAndPoll - discriminated union for success/failure.
 */
export type QueueJobResult =
	| { status: "completed"; data: Blob }
	| { status: "failed"; error: string };

/**
 * Infer model inputs from the model's Zod schema.
 */
type InferModelInputs<T extends ModelDefinition> =
	T["name"] extends keyof ModelInputSchemas
		? z.input<ModelInputSchemas[T["name"]]>
		: Record<string, never>;

/**
 * Model-specific input documentation for image generation models.
 */
interface ImageGenerationInputs {
	/**
	 * Text description to use for the generation.
	 */
	prompt: string;
}

/**
 * Model-specific input documentation for image editing models.
 */
interface ImageEditingInputs {
	/**
	 * Text description of the changes to apply to the image.
	 */
	prompt: string;
}

/**
 * Model-specific input documentation for video models.
 */
interface VideoModelInputs {
	/**
	 * Text description to use for the generation.
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

/**
 * Conditional type that selects the appropriate model-specific input documentation.
 */
type ModelSpecificInputs<T extends ModelDefinition> =
	T["name"] extends "lucy-pro-i2i"
		? ImageEditingInputs
		: T["name"] extends ImageModels
			? ImageGenerationInputs
			: T["name"] extends VideoModels
				? VideoModelInputs
				: PromptInput;

interface QueueInputs {
	/**
	 * Random seed for reproducible results.
	 */
	seed?: number;
	/**
	 * The output resolution to use for the generation.
	 * @default "720p"
	 */
	resolution?: "480p" | "720p";
	/**
	 * The output orientation to use for the generation.
	 * @default "landscape"
	 */
	orientation?: "landscape" | "portrait";
	/**
	 * The data to use for generation (for image-to-image and video-to-video).
	 */
	data?: FileInput;
	/**
	 * The start frame image (for first-last-frame models).
	 */
	start?: FileInput;
	/**
	 * The end frame image (for first-last-frame models).
	 */
	end?: FileInput;
	/**
	 * Whether to enhance the prompt.
	 * @default true
	 */
	enhance_prompt?: boolean;
	/**
	 * The number of inference steps.
	 * @default 50
	 */
	num_inference_steps?: number;
}

type ModelSpecificQueueInputs<T extends ModelDefinition> = QueueInputs &
	ModelSpecificInputs<T>;

type PickDocumentedInputs<T extends ModelDefinition> = Pick<
	ModelSpecificQueueInputs<T>,
	keyof ModelSpecificQueueInputs<T> & keyof InferModelInputs<T>
>;

type MergeDocumentedInputs<T extends ModelDefinition> =
	PickDocumentedInputs<T> & InferModelInputs<T>;

/**
 * Options for queue.submit() - submit a job for async processing.
 */
export type QueueSubmitOptions<T extends ModelDefinition = ModelDefinition> = {
	/**
	 * The model definition to use.
	 */
	model: T;
	/**
	 * Optional `AbortSignal` for canceling the request.
	 */
	signal?: AbortSignal;
} & MergeDocumentedInputs<T>;

/**
 * Options for queue.submitAndPoll() - submit and wait for completion.
 */
export type QueueSubmitAndPollOptions<
	T extends ModelDefinition = ModelDefinition,
> = QueueSubmitOptions<T> & {
	/**
	 * Callback invoked when job status changes during polling.
	 * Receives the full job status response object.
	 */
	onStatusChange?: (job: JobStatusResponse) => void;
};
