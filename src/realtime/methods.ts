import { z } from "zod";
import type { PromptAckMessage } from "./types";
import type { WebRTCManager } from "./webrtc-manager";

const PROMPT_TIMEOUT_MS = 15 * 1000; // 15 seconds

export const realtimeMethods = (webrtcManager: WebRTCManager) => {
	const setPrompt = async (
		prompt: string,
		{ enhance }: { enhance?: boolean } = {},
	): Promise<void> => {
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
			// Set up the acknowledgment promise with listener
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

			// Send the message first
			webrtcManager.sendMessage({
				type: "prompt",
				prompt: parsedInput.data.prompt,
				enhance_prompt: parsedInput.data.enhance,
			});

			// Start the timeout after sending
			const timeoutPromise = new Promise<void>((_, reject) => {
				timeoutId = setTimeout(
					() => reject(new Error("Prompt timed out")),
					PROMPT_TIMEOUT_MS,
				);
			});

			// Race between acknowledgment and timeout
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
		setPrompt,
	};
};
