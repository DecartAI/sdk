import { z } from "zod";
import type { PromptAckMessage } from "./types";
import type { WebRTCManager } from "./webrtc-manager";

export const realtimeMethods = (webrtcManager: WebRTCManager) => {
	const setPrompt = (
		prompt: string,
		{ enhance }: { enhance?: boolean } = {},
	) => {
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

		webrtcManager.sendMessage({
			type: "prompt",
			prompt: parsedInput.data.prompt,
			enhance_prompt: parsedInput.data.enhance,
		});
	};

	const setPromptPromise = (
		prompt: string,
		{
			enhance,
			maxTimeout = 15 * 1000,
		}: { enhance?: boolean; maxTimeout?: number } = {},
	): Promise<boolean> => {
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

		return new Promise((r, e) => {
			let timeout: NodeJS.Timeout;

			const promptAckListener = (promptAckMessage: PromptAckMessage) => {
				if (promptAckMessage.prompt === prompt) {
					clearTimeout(timeout);
					emitter.off("promptAck", promptAckListener);
					if (promptAckMessage.success) {
						r(true);
					} else {
						e(promptAckMessage.error);
					}
				}
			};

			emitter.on("promptAck", promptAckListener);

			webrtcManager.sendMessage({
				type: "prompt",
				prompt: parsedInput.data.prompt,
				enhance_prompt: parsedInput.data.enhance,
			});
			timeout = setTimeout(() => {
				emitter.off("promptAck", promptAckListener);
				e(false);
			}, maxTimeout);
		});
	};

	return {
		setPrompt,
		setPromptPromise,
	};
};
