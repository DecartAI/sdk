import { z } from "zod";

export const modelStateSchema = z.object({
  prompt: z
    .union([
      z.object({
        text: z.string().min(1),
        enhance: z.boolean().optional().default(true),
      }),
      z.null(),
    ])
    .optional(),
  image: z.union([z.instanceof(Blob), z.instanceof(File), z.string()]).optional(),
});
export type ModelState = z.infer<typeof modelStateSchema>;
