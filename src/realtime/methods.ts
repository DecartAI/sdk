import { z } from "zod";
import type { WebRTCManager } from "./webrtc-manager";

export const realtimeMethods = (webrtcManager: WebRTCManager) => {
	const enrichPrompt = (_prompt: string) => {
		throw new Error("Not implemented");
	};

	const setPrompt = (prompt: string, { enrich }: { enrich?: boolean } = {}) => {
		const schema = z.object({
			prompt: z.string().min(1),
			enrich: z.boolean().optional().default(true),
		});

		const parsedInput = schema.safeParse({
			prompt,
			enrich,
		});

		if (!parsedInput.success) {
			throw parsedInput.error;
		}

		webrtcManager.sendMessage({
			type: "prompt",
			prompt: parsedInput.data.prompt,
			should_enrich: parsedInput.data.enrich,
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
		enrichPrompt,
		setPrompt,
		setMirror,
	};
};
