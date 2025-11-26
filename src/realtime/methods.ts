import { z } from "zod";
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

	return {
		setPrompt,
	};
};
