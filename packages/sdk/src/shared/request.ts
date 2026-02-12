import type { FileInput, ReactNativeFile } from "../process/types";
import { createFileTooLargeError, createInvalidInputError } from "../utils/errors";
import { buildUserAgent } from "../utils/user-agent";

/**
 * Maximum file size allowed for uploads (20MB).
 */
export const MAX_FILE_SIZE = 20 * 1024 * 1024;

/**
 * Type guard to check if a value is a React Native file object.
 */
function isReactNativeFile(value: unknown): value is ReactNativeFile {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ReactNativeFile).uri === "string" &&
    typeof (value as ReactNativeFile).type === "string" &&
    typeof (value as ReactNativeFile).name === "string"
  );
}

/**
 * Convert various file input types to a Blob or React Native file object.
 * React Native file objects are passed through as-is for proper FormData handling.
 */
export async function fileInputToBlob(input: FileInput, fieldName?: string): Promise<Blob | ReactNativeFile> {
  // React Native file object - pass through as-is (cannot check size)
  if (isReactNativeFile(input)) {
    return input;
  }

  let blob: Blob;

  if (input instanceof Blob || input instanceof File) {
    blob = input;
  } else if (input instanceof ReadableStream) {
    const response = new Response(input);
    blob = await response.blob();
  } else if (typeof input === "string" || input instanceof URL) {
    const url = typeof input === "string" ? input : input.toString();

    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      throw createInvalidInputError("URL must start with http:// or https://");
    }

    const response = await fetch(url);
    if (!response.ok) {
      throw createInvalidInputError(`Failed to fetch file from URL: ${response.statusText}`);
    }
    blob = await response.blob();
  } else {
    throw createInvalidInputError("Invalid file input type");
  }

  // Validate file size
  if (blob.size > MAX_FILE_SIZE) {
    throw createFileTooLargeError(blob.size, MAX_FILE_SIZE, fieldName);
  }

  return blob;
}

/**
 * Build common headers for API requests.
 */
export function buildAuthHeaders(options: { apiKey?: string; integration?: string } = {}): HeadersInit {
  const { apiKey, integration } = options;

  const headers: HeadersInit = {
    "User-Agent": buildUserAgent(integration),
    ...(apiKey ? { "X-API-KEY": apiKey } : {}),
  };

  return headers;
}

/**
 * Build FormData from inputs object.
 */
export function buildFormData(inputs: Record<string, unknown>): FormData {
  const formData = new FormData();

  for (const [key, value] of Object.entries(inputs)) {
    if (value !== undefined && value !== null) {
      // React Native file object - append as-is for native file upload handling
      if (isReactNativeFile(value)) {
        formData.append(key, value as unknown as Blob);
      } else if (value instanceof Blob) {
        formData.append(key, value);
      } else if (typeof value === "object" && value !== null) {
        formData.append(key, JSON.stringify(value));
      } else {
        formData.append(key, String(value));
      }
    }
  }

  return formData;
}
