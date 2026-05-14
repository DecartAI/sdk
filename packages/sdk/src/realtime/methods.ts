import { z } from "zod";
import { REALTIME_CONFIG } from "./config-realtime";
import type { StreamSession } from "./stream-session";
import type { PromptSendOptions } from "./types";

const setInputSchema = z
  .object({
    prompt: z.string().min(1).optional(),
    enhance: z.boolean().optional().default(true),
    image: z.union([z.instanceof(Blob), z.instanceof(File), z.string(), z.null()]).optional(),
  })
  .refine((data) => data.prompt !== undefined || data.image !== undefined, {
    message: "At least one of 'prompt' or 'image' must be provided",
  });

const setPromptInputSchema = z.object({
  prompt: z.string().min(1),
  enhance: z.boolean().optional().default(true),
});

export type SetInput = z.input<typeof setInputSchema>;

export const realtimeMethods = (
  session: StreamSession,
  imageToBase64: (image: Blob | File | string) => Promise<string>,
) => {
  const set = async (input: SetInput): Promise<void> => {
    const parsed = setInputSchema.safeParse(input);
    if (!parsed.success) throw parsed.error;

    const { prompt, enhance, image } = parsed.data;
    const imageBase64 = image !== undefined && image !== null ? await imageToBase64(image) : null;

    await session.setImage(imageBase64, { prompt, enhance, timeout: REALTIME_CONFIG.methods.updateTimeoutMs });
  };

  const setPrompt = async (prompt: string, { enhance }: PromptSendOptions = {}): Promise<void> => {
    const parsed = setPromptInputSchema.safeParse({ prompt, enhance });
    if (!parsed.success) throw parsed.error;

    await session.sendPrompt(parsed.data.prompt, {
      enhance: parsed.data.enhance,
      timeout: REALTIME_CONFIG.methods.promptTimeoutMs,
    });
  };

  return { set, setPrompt };
};
