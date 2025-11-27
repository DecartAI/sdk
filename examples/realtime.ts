import {
	createDecartClient,
	type DecartSDKError,
	models,
	type RealTimeClientConnectOptions,
	type RealTimeClientInitialState,
} from "@decartai/sdk";

const model = models.realtime("mirage_v2");

const stream = await navigator.mediaDevices.getUserMedia({
	audio: true,
	video: {
		frameRate: model.fps,
		width: model.width,
		height: model.height,
	},
});

// 1. Create a client
const client = createDecartClient({
	baseUrl: "https://custom-endpoint.decart.ai", // optional, defaults to https://api3.decart.ai
	apiKey: "dcrt-dLMPLEvXIuYPCpC0U5QKJh7jTH9RK8EoAaMT",
});

// 2. Connect to the realtime API
const realtimeClient = await client.realtime.connect(stream, {
	model,
	onRemoteStream: (stream: MediaStream) => {
		console.log("remote stream", stream);
	},
	initialState: {
		prompt: {
			// optional, defaults to undefined, will return the original stream if no prompt is sent
			text: "Lego World",
			enhance: true, // optional, defaults to true
		},
	} satisfies RealTimeClientInitialState,
} satisfies RealTimeClientConnectOptions);

// 3. Prompt Management
// 3.1 Sending a prompt (fire-and-forget, don't wait for acknowledgment)
realtimeClient.setPrompt("Lego World"); // Returns a promise, but we don't await it

// 3.2 Sending a prompt and waiting for server acknowledgment
try {
	const success = await realtimeClient.setPrompt("Lego World", {
		enhance: true, // optional, defaults to true
		maxTimeout: 15000, // optional, defaults to 15000ms
	});
	console.log("Prompt acknowledged by server:", success);
} catch (error) {
	console.error("Prompt failed or timed out:", error);
}

// 3.3 Sending an already enhanced prompt (skip enhancement)
realtimeClient.setPrompt(
	"A very long prompt that is very descriptive and detailed",
	{
		enhance: false,
	},
);

// 5. State Management
// 5.1 Get the connection state synchronously
const isConnected: boolean = realtimeClient.isConnected();
const connectionState: "connected" | "connecting" | "disconnected" =
	realtimeClient.getConnectionState();

// 5.2 Subscribe to connection change events asynchronously
const onConnectionChange = (
	state: "connected" | "connecting" | "disconnected",
) => {
	console.log(`Connection state changed to ${state}`);
};
realtimeClient.on("connectionChange", onConnectionChange);
realtimeClient.off("connectionChange", onConnectionChange);

// 5.3 Get the session ID
const sessionId = realtimeClient.sessionId;

// 6. Error Handling
const onError = (error: DecartSDKError) => {
	console.error("Error", error);
};
realtimeClient.on("error", onError);
realtimeClient.off("error", onError);

// 7. Disconnect
realtimeClient.disconnect();
