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
 * Files expire after a server-configured TTL (default 24 h). `expires_at` is
 * `null` when the upload was created with `persistent: true`.
 */
export interface FileReference {
  id: string;
  filename: string | null;
  /** Type of the stored file. The API re-encodes non-JPEG images to JPEG, so a PNG upload reports `image/jpeg`. */
  mime_type: string;
  size_bytes: number;
  /**
   * Lowercase hex MD5 of the uploaded bytes; pass it to `client.files.getByMd5(...)`
   * to find this file again without its id. `null` on files uploaded before
   * hashes were recorded.
   */
  md5: string | null;
  created_at: string;
  expires_at: string | null;
}

export type FileUploadInput = File | Blob | ReactNativeFile;
