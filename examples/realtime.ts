import {
	createMirageClient,
	type MirageSDKError,
	type RealTimeClientConnectOptions,
	type RealTimeClientInitialState,
} from "@decartai/mirage";

const stream = await navigator.mediaDevices.getUserMedia({
	audio: true,
	video: {
		frameRate: 14,
	},
});

// 1. Create a client
const client = createMirageClient({
	baseUrl: "https://api.decart.ai/mirage/v1", // optional, defaults to https://bouncer.mirage.decart.ai
	apiKey: "dcrt-dLMPLEvXIuYPCpC0U5QKJh7jTH9RK8EoAaMT",
});

// 2. Connect to the realtime API
const mirage = await client.realtime.connect(stream, {
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
mirage.setPrompt("Lego World");

// 3.2 Sending an already enriched prompt (great for advanced use-cases)
mirage.setPrompt("A very long prompt that is very descriptive and detailed", {
	enrich: false, // optional, defaults to true
});

// 3.3 Enriching a prompt and sending it (great for advanced use-cases)
// const enrichedPrompt = await mirage.enrichPrompt("Anime");
// mirage.setPrompt(enrichedPrompt, {
// 	enrich: false, // optional, defaults to true
// });

// 4. Mirroring (useful utility for use-cases like front-facing cameras)
mirage.setMirror(true);

// 5. State Management
// 5.1 Get the connection state synchronously
const isConnected: boolean = mirage.isConnected();
const connectionState: "connected" | "connecting" | "disconnected" =
	mirage.getConnectionState();

// 5.2 Subscribe to connection change events asynchronously
const onConnectionChange = (
	state: "connected" | "connecting" | "disconnected",
) => {
	console.log(`Connection state changed to ${state}`);
};
mirage.on("connectionChange", onConnectionChange);
mirage.off("connectionChange", onConnectionChange);

// 6. Error Handling
const onError = (error: MirageSDKError) => {
	console.error("Error", error);
};
mirage.on("error", onError);
mirage.off("error", onError);

// 7. Disconnect
mirage.disconnect();
