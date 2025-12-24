import type { ImageModelDefinition } from "../shared/model";
import { fileInputToBlob } from "../shared/request";
import { createInvalidInputError } from "../utils/errors";
import { sendRequest } from "./request";
import type { FileInput, ProcessOptions } from "./types";

/**
 * Client for synchronous image generation.
 * Only image models (t2i, i2i) support the sync/process API.
 */
export type ProcessClient = <T extends ImageModelDefinition>(options: ProcessOptions<T>) => Promise<Blob>;

export type ProcessClientOptions = {
  apiKey: string;
  baseUrl: string;
  integration?: string;
  proxy?: boolean;
};

export const createProcessClient = (opts: ProcessClientOptions): ProcessClient => {
  const { apiKey, baseUrl, integration, proxy = false } = opts;

  const _process = async <T extends ImageModelDefinition>(options: ProcessOptions<T>): Promise<Blob> => {
    const { model, signal, ...inputs } = options;

    const parsedInputs = model.inputSchema.safeParse(inputs);
    if (!parsedInputs.success) {
      throw createInvalidInputError(`Invalid inputs for ${model.name}: ${parsedInputs.error.message}`);
    }

    const processedInputs: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parsedInputs.data as Record<string, unknown>)) {
      if (key === "data" || key === "start" || key === "end") {
        processedInputs[key] = await fileInputToBlob(value as FileInput);
      } else {
        processedInputs[key] = value;
      }
    }

    const response = await sendRequest({
      baseUrl,
      apiKey,
      model,
      inputs: processedInputs,
      signal,
      integration,
      proxy,
    });

    return response;
  };

  return _process;
};
