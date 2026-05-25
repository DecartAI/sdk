import type { ReactNativeFile } from "../process/types";

/** Prefix on every uploaded-file id; disambiguates a ref string from base64. */
export const FILE_REF_PREFIX = "file_";

/** True if `value` is a `"file_..."` reference id from `client.files.upload(...)`. */
export const isFileRefId = (value: unknown): value is string =>
  typeof value === "string" && value.startsWith(FILE_REF_PREFIX);

/**
 * Metadata for a previously-uploaded file. Returned by `client.files.upload(...)`.
 * Pass `ref.id` to `realtime.set({ image })` / `setImage(...)` to reuse it.
 *
 * Files expire after a server-configured TTL (currently 24 h).
 */
export interface FileReference {
  id: string;
  filename: string | null;
  mime_type: string;
  size_bytes: number;
  created_at: string;
  expires_at: string;
}

export type FileUploadInput = File | Blob | ReactNativeFile;
