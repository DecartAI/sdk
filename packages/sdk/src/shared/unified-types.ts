import type { InferModelInputs, ModelSpecificInputs, ProcessInputs } from "../process/types";
import type { JobStatusResponse } from "../queue/types";
import type { ImageModels, ModelDefinition, VideoModels } from "./model";

/**
 * Model definitions that support synchronous generation (have urlPath).
 * Currently includes all image and video models.
 */
export type SyncCapableModelDefinition = ModelDefinition<ImageModels | VideoModels>;

/**
 * Model definitions that support asynchronous queue processing (have queueUrlPath).
 * Currently includes all image and video models.
 */
export type AsyncCapableModelDefinition = ModelDefinition<ImageModels | VideoModels>;

/**
 * Pick only the fields from ModelSpecificProcessInputs that exist in the inferred model inputs,
 * so JSDoc comments will be preserved, while type inference will be accurate.
 */
type PickDocumentedInputs<T extends ModelDefinition> = Pick<
  ProcessInputs & ModelSpecificInputs<T>,
  keyof (ProcessInputs & ModelSpecificInputs<T>) & keyof InferModelInputs<T>
>;

/**
 * Merge documented inputs with inferred inputs, ensuring zod types take precedence
 * while preserving JSDoc comments from ModelSpecificProcessInputs.
 */
type MergeDocumentedInputs<T extends ModelDefinition> = PickDocumentedInputs<T> & InferModelInputs<T>;

/**
 * Options for synchronous generation.
 * Works with any model that has a urlPath (sync endpoint).
 *
 * @template T - The model definition type (must support sync generation)
 */
export type GenerateOptions<T extends SyncCapableModelDefinition = SyncCapableModelDefinition> = {
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
 * Options for async job submission.
 * Works with any model that has a queueUrlPath (async endpoint).
 *
 * @template T - The model definition type (must support async queue)
 */
export type SubmitOptions<T extends AsyncCapableModelDefinition = AsyncCapableModelDefinition> = {
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
 * Options for async job submission with automatic polling.
 * Works with any model that has a queueUrlPath (async endpoint).
 *
 * @template T - The model definition type (must support async queue)
 */
export type SubmitAndWaitOptions<T extends AsyncCapableModelDefinition = AsyncCapableModelDefinition> =
  SubmitOptions<T> & {
    /**
     * Callback invoked when job status changes during polling.
     * Receives the full job status response object.
     *
     * @deprecated Use `onProgress` instead. This will be removed in a future version.
     */
    onStatusChange?: (job: JobStatusResponse) => void;
    /**
     * Callback invoked when job status changes during polling.
     * Receives the full job status response object.
     */
    onProgress?: (job: JobStatusResponse) => void;
  };
