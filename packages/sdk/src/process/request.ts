import type { ModelDefinition } from "../shared/model";
import { buildAuthHeaders, buildFormData } from "../shared/request";
import { createSDKError } from "../utils/errors";
import { buildUserAgent } from "../utils/user-agent";

export async function sendRequest({
  baseUrl,
  apiKey,
  model,
  inputs,
  signal,
  integration,
  proxy = false,
}: {
  baseUrl: string;
  apiKey: string;
  model: ModelDefinition;
  inputs: Record<string, unknown>;
  signal?: AbortSignal;
  integration?: string;
  proxy?: boolean;
}): Promise<Blob> {
  const formData = buildFormData(inputs);

  const endpoint = `${baseUrl}${model.urlPath}`;
  const headers = proxy
    ? { "User-Agent": buildUserAgent(integration) }
    : buildAuthHeaders(apiKey, integration);

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: formData,
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unknown error");
    throw createSDKError("PROCESSING_ERROR", `Processing failed: ${response.status} - ${errorText}`);
  }

  return response.blob();
}
