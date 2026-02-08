import { z } from "zod";
import type { PromptAckMessage, SetMessage } from "./types";
import type { WebRTCManager } from "./webrtc-manager";

const PROMPT_TIMEOUT_MS = 15 * 1000;
const UPDATE_TIMEOUT_MS = 30 * 1000;

const setInputSchema = z
  .object({
    prompt: z.string().min(1).optional(),
    enhance: z.boolean().optional(),
    image: z.union([z.instanceof(Blob), z.instanceof(File), z.string(), z.null()]).optional(),
  })
  .refine((data) => data.prompt !== undefined || data.image !== undefined, {
    message: "At least one of 'prompt' or 'image' must be provided",
  });

export type SetInput = z.input<typeof setInputSchema>;

export const realtimeMethods = (
  webrtcManager: WebRTCManager,
  imageToBase64: (image: Blob | File | string) => Promise<string>,
) => {
  const set = async (input: SetInput): Promise<void> => {
    const parsed = setInputSchema.safeParse(input);
    if (!parsed.success) {
      throw parsed.error;
    }

    const { prompt, enhance, image } = parsed.data;

    const message: SetMessage = { type: "set" };

    if (prompt !== undefined) {
      message.prompt = prompt;
    }
    if (enhance !== undefined) {
      message.enhance_prompt = enhance;
    }

    if (image !== undefined) {
      if (image === null) {
        message.image_data = null;
      } else {
        message.image_data = await imageToBase64(image);
      }
    }

    await webrtcManager.sendSet(message, UPDATE_TIMEOUT_MS);
  };

  const setPrompt = async (prompt: string, { enhance }: { enhance?: boolean } = {}): Promise<void> => {
    const schema = z.object({
      prompt: z.string().min(1),
      enhance: z.boolean().optional().default(true),
    });

    const parsedInput = schema.safeParse({
      prompt,
      enhance,
    });

    if (!parsedInput.success) {
      throw parsedInput.error;
    }

    const emitter = webrtcManager.getWebsocketMessageEmitter();
    let promptAckListener: ((msg: PromptAckMessage) => void) | undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    try {
      const ackPromise = new Promise<void>((resolve, reject) => {
        promptAckListener = (promptAckMessage: PromptAckMessage) => {
          if (promptAckMessage.prompt === parsedInput.data.prompt) {
            if (promptAckMessage.success) {
              resolve();
            } else {
              reject(promptAckMessage.error);
            }
          }
        };
        emitter.on("promptAck", promptAckListener);
      });

      webrtcManager.sendMessage({
        type: "prompt",
        prompt: parsedInput.data.prompt,
        enhance_prompt: parsedInput.data.enhance,
      });

      const timeoutPromise = new Promise<void>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error("Prompt timed out")), PROMPT_TIMEOUT_MS);
      });

      await Promise.race([ackPromise, timeoutPromise]);
    } finally {
      if (promptAckListener) {
        emitter.off("promptAck", promptAckListener);
      }
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  };

  return {
    set,
    setPrompt,
  };
};
