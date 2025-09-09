import {
	createDecartClient,
	type DecartSDKError,
	models,
	type RealTimeClientConnectOptions,
	type RealTimeClientInitialState,
} from "@decartai/sdk";

const model = models.v2v("decart-v2v-v2.1-704p");

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
	baseUrl: "https://api.decart.ai", // optional, defaults to https://bouncer.mirage.decart.ai
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
			enrich: true, // optional, defaults to true
		},
		mirror: false, // optional, defaults to false (useful for use-cases like front-facing cameras)
	} satisfies RealTimeClientInitialState,
} satisfies RealTimeClientConnectOptions);

// 3. Prompt Management
// 3.1 Sending a prompt, the prompt will be enriched automatically (great for out-of-the-box experience)
realtimeClient.setPrompt("Lego World");

// 3.2 Sending an already enriched prompt (great for advanced use-cases)
realtimeClient.setPrompt(
	"A very long prompt that is very descriptive and detailed",
	{
		enrich: false, // optional, defaults to true
	},
);

// 3.3 Enriching a prompt and sending it (great for advanced use-cases)
// const enrichedPrompt = await realtimeClient.enrichPrompt("Anime");
// realtimeClient.setPrompt(enrichedPrompt, {
// 	enrich: false, // optional, defaults to true
// });

// 4. Mirroring (useful utility for use-cases like front-facing cameras)
realtimeClient.setMirror(true);

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
