import type { InferModelInputs, ModelSpecificInputs, ProcessInputs } from "../process/types";
import type { JobStatusResponse } from "../queue/types";
import type { ImageModels, ModelDefinition, VideoModels } from "./model";
import type { MergeDocumentedFields } from "./type-helpers";

/**
 * Model definitions that support both synchronous and asynchronous generation.
 * Currently includes all image and video models.
 */
export type GenerationCapableModelDefinition = ModelDefinition<ImageModels | VideoModels>;

/**
 * Options for synchronous generation.
 * Works with any model that has a urlPath (sync endpoint).
 *
 * @template T - The model definition type (must support generation)
 */
export type GenerateOptions<T extends GenerationCapableModelDefinition = GenerationCapableModelDefinition> = {
  /**
   * The model definition to use.
   */
  model: T;
  /**
   * Optional `AbortSignal` for canceling the request.
   */
  signal?: AbortSignal;
} & MergeDocumentedFields<ProcessInputs & ModelSpecificInputs<T>, InferModelInputs<T>>;

/**
 * Options for async job submission.
 * Works with any model that has a queueUrlPath (async endpoint).
 *
 * @template T - The model definition type (must support async queue)
 */
export type SubmitOptions<T extends GenerationCapableModelDefinition = GenerationCapableModelDefinition> = {
  /**
   * The model definition to use.
   */
  model: T;
  /**
   * Optional `AbortSignal` for canceling the request.
   */
  signal?: AbortSignal;
} & MergeDocumentedFields<ProcessInputs & ModelSpecificInputs<T>, InferModelInputs<T>>;

/**
 * Options for async job submission with automatic polling.
 * Works with any model that has a queueUrlPath (async endpoint).
 *
 * @template T - The model definition type (must support async queue)
 */
export type SubmitAndWaitOptions<T extends GenerationCapableModelDefinition = GenerationCapableModelDefinition> =
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
