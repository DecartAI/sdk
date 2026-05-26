import { z } from "zod";

export const modelStateSchema = z.object({
  prompt: z
    .object({
      text: z.string().min(1),
      enhance: z.boolean().optional().default(true),
    })
    .optional(),
  /**
   * Initial image for the session. Pass either bytes (`Blob`/`File`/data URL/
   * http(s) URL/base64 string) or a `"file_..."` id returned by
   * `client.files.upload(...)`.id — the SDK detects the prefix and sends a
   * server-side reference instead of base64.
   */
  image: z.union([z.instanceof(Blob), z.instanceof(File), z.string()]).optional(),
});
export type ModelState = z.infer<typeof modelStateSchema>;
