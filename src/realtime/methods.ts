import { z } from "zod";
import type { PromptAckMessage } from "./types";
import type { WebRTCManager } from "./webrtc-manager";

export const realtimeMethods = (webrtcManager: WebRTCManager) => {
	const setPrompt = (
		prompt: string,
		{ enhance, maxTimeout }: { enhance?: boolean; maxTimeout?: number } = {},
	): Promise<boolean> => {
		const schema = z.object({
			prompt: z.string().min(1),
			enhance: z.boolean().optional().default(true),
			maxTimeout: z
				.number()
				.positive()
				.max(60 * 1000)
				.optional()
				.default(15 * 1000),
		});

		const parsedInput = schema.safeParse({
			prompt,
			enhance,
			maxTimeout,
		});

		if (!parsedInput.success) {
			throw parsedInput.error;
		}

		const emitter = webrtcManager.getWebsocketMessageEmitter();

		return new Promise((r, e) => {
			let timeout: NodeJS.Timeout;

			const promptAckListener = (promptAckMessage: PromptAckMessage) => {
				if (promptAckMessage.prompt === parsedInput.data.prompt) {
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
			}, parsedInput.data.maxTimeout);
		});
	};

	return {
		setPrompt,
	};
};
