/**
 * Browser-only example - requires WebRTC APIs
 * Demonstrates connection state handling and error events
 * See examples/nextjs-realtime or examples/react-vite for runnable demos
 */

import { createDecartClient, type DecartSDKError, models } from "@decartai/sdk";

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
			console.log("Received transformed stream");
			const video = document.getElementById("output") as HTMLVideoElement;
			video.srcObject = transformedStream;
		},
	});

	// Subscribe to connection state changes
	realtimeClient.on("connectionChange", (state) => {
		switch (state) {
			case "connecting":
				console.log("Connecting to server...");
				break;
			case "connected":
				console.log("Connected! Streaming active.");
				break;
			case "disconnected":
				console.log("Disconnected from server.");
				break;
		}
	});

	// Subscribe to errors
	realtimeClient.on("error", (error: DecartSDKError) => {
		console.error("Error:", error.message);
	});

	// Check connection state synchronously
	console.log("Is connected:", realtimeClient.isConnected());
	console.log("Connection state:", realtimeClient.getConnectionState());

	// Cleanup on page unload
	window.addEventListener("beforeunload", () => {
		realtimeClient.disconnect();
	});
}

main();
