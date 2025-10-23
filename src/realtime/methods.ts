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

	const setMirror = (enabled: boolean) => {
		const schema = z.object({
			enabled: z.boolean(),
		});

		const parsedInput = schema.safeParse({
			enabled,
		});

		if (!parsedInput.success) {
			throw parsedInput.error;
		}

		webrtcManager.sendMessage({
			type: "switch_camera",
			rotateY: parsedInput.data.enabled ? 2 : 0,
		});
	};

	return {
		setPrompt,
		setMirror,
	};
};
