/**
 * Browser-only example - requires WebRTC APIs
 * Mirage v2 for realtime style transformation
 * See examples/nextjs-realtime or examples/react-vite for runnable demos
 */

import { createDecartClient, models } from "@decartai/sdk";

async function main() {
	const model = models.realtime("mirage_v2");

	// Get webcam stream with model-specific settings
	const stream = await navigator.mediaDevices.getUserMedia({
		audio: true,
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
			prompt: {
				text: "Studio Ghibli animation style",
				enhance: true,
			},
		},
	});

	// Change styles dynamically
	realtimeClient.setPrompt("Cyberpunk city");
	realtimeClient.setPrompt("Oil painting, renaissance style");

	console.log("Session ID:", realtimeClient.sessionId);
	console.log("Connected:", realtimeClient.isConnected());
}

main();
