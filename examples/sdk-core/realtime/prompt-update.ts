/**
 * Browser-only example - requires WebRTC APIs
 * Demonstrates updating prompts dynamically
 * See examples/nextjs-realtime or examples/react-vite for runnable demos
 */

import { createDecartClient, models } from "@decartai/sdk";

async function main() {
	const model = models.realtime("mirage_v2");

	const stream = await navigator.mediaDevices.getUserMedia({
		video: {
			frameRate: model.fps,
			width: model.width,
			height: model.height,
		},
	});

	const client = createDecartClient({
		apiKey: process.env.DECART_API_KEY!,
	});

	const realtimeClient = await client.realtime.connect(stream, {
		model,
		onRemoteStream: (transformedStream) => {
			const video = document.getElementById("output") as HTMLVideoElement;
			video.srcObject = transformedStream;
		},
		initialState: {
			prompt: { text: "oil painting style", enhance: true },
		},
	});

	// Update prompt from UI input (fire-and-forget)
	const promptInput = document.getElementById("prompt") as HTMLInputElement;
	promptInput.addEventListener("input", () => {
		realtimeClient.setPrompt(promptInput.value);
	});

	// Update with pre-enhanced prompt (skip server enhancement)
	realtimeClient.setPrompt(
		"A very detailed and specific prompt that is already well-crafted",
		{ enhance: false },
	);

	// Update and wait for acknowledgment
	await realtimeClient.setPrompt("cyberpunk city");
	console.log("Prompt updated and acknowledged");
}

main();
