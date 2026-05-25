import { buildAuthHeaders } from "../shared/request";
import { createSDKError } from "../utils/errors";
import type { FileReference, FileUploadInput } from "./types";

export type FilesClientOptions = {
  baseUrl: string;
  apiKey: string;
  integration?: string;
};

export type UploadFileOptions = {
  signal?: AbortSignal;
  /**
   * Expiration:
   * - omit → platform default (24 h)
   * - a positive integer → TTL in seconds (60 .. 2_592_000)
   * - `"persistent"` → never expires
   */
  ttlSeconds?: number | "persistent";
};

export type FilesClient = {
  /**
   * Upload a file once and get a reusable reference. Pass `ref.id` to
   * realtime `set({ image })` to reuse the same asset across generations
   * without re-uploading.
   *
   * @example
   * ```ts
   * const ref = await client.files.upload(blob);
   * await rt.set({ image: ref.id, prompt: "make it cinematic" });
   * await rt.set({ image: ref.id, prompt: "now in noir" });   // reused, no re-upload
   * ```
   */
  upload: (file: FileUploadInput, options?: UploadFileOptions) => Promise<FileReference>;
  get: (fileId: string) => Promise<FileReference>;
  delete: (fileId: string) => Promise<void>;
};

export const createFilesClient = (opts: FilesClientOptions): FilesClient => {
  const { baseUrl, apiKey, integration } = opts;

  const upload = async (file: FileUploadInput, options?: UploadFileOptions): Promise<FileReference> => {
    const formData = new FormData();
    formData.append("file", file as Blob);
    if (options?.ttlSeconds !== undefined) formData.append("ttl_seconds", String(options.ttlSeconds));

    const response = await fetch(`${baseUrl}/v1/files`, {
      method: "POST",
      headers: buildAuthHeaders({ apiKey, integration }),
      body: formData,
      signal: options?.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw createSDKError("FILES_UPLOAD_ERROR", `Failed to upload file: ${response.status} - ${errorText}`, {
        status: response.status,
      });
    }
    return response.json();
  };

  const get = async (fileId: string): Promise<FileReference> => {
    const response = await fetch(`${baseUrl}/v1/files/${encodeURIComponent(fileId)}`, {
      method: "GET",
      headers: buildAuthHeaders({ apiKey, integration }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw createSDKError("FILES_GET_ERROR", `Failed to get file: ${response.status} - ${errorText}`, {
        status: response.status,
      });
    }
    return response.json();
  };

  const deleteFile = async (fileId: string): Promise<void> => {
    const response = await fetch(`${baseUrl}/v1/files/${encodeURIComponent(fileId)}`, {
      method: "DELETE",
      headers: buildAuthHeaders({ apiKey, integration }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw createSDKError("FILES_DELETE_ERROR", `Failed to delete file: ${response.status} - ${errorText}`, {
        status: response.status,
      });
    }
  };

  return { upload, get, delete: deleteFile };
};
