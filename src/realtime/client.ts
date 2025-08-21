import mitt from "mitt";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { modelDefinitionSchema } from "../shared/model";
import { modelStateSchema } from "../shared/types";
import { createWebrtcError, type DecartSDKError } from "../utils/errors";
import { realtimeMethods } from "./methods";
import { WebRTCManager } from "./webrtc-manager";

export type RealTimeClientOptions = {
	baseUrl: string;
	apiKey: string;
};

const realTimeClientInitialStateSchema = modelStateSchema;
type OnRemoteStreamFn = (stream: MediaStream) => void;
export type RealTimeClientInitialState = z.infer<
	typeof realTimeClientInitialStateSchema
>;

const realTimeClientConnectOptionsSchema = z.object({
	model: modelDefinitionSchema,
	onRemoteStream: z.custom<OnRemoteStreamFn>(
		(val) => typeof val === "function",
		{ message: "onRemoteStream must be a function" },
	),
	initialState: realTimeClientInitialStateSchema.optional(),
});
export type RealTimeClientConnectOptions = z.infer<
	typeof realTimeClientConnectOptionsSchema
>;

export type Events = {
	connectionChange: "connected" | "connecting" | "disconnected";
	error: DecartSDKError;
};

export type RealTimeClient = {
	enrichPrompt: (prompt: string) => Promise<string>;
	setPrompt: (prompt: string, { enrich }?: { enrich?: boolean }) => void;
	setMirror: (enabled: boolean) => void;
	isConnected: () => boolean;
	getConnectionState: () => "connected" | "connecting" | "disconnected";
	disconnect: () => void;
	on: (
		event: keyof Events,
		listener: (...args: Events[keyof Events][]) => void,
	) => void;
	off: (
		event: keyof Events,
		listener: (...args: Events[keyof Events][]) => void,
	) => void;
	sessionId: string;
};

export const createRealTimeClient = (opts: RealTimeClientOptions) => {
	const { baseUrl, apiKey } = opts;

	const connect = async (
		stream: MediaStream,
		options: RealTimeClientConnectOptions,
	): Promise<RealTimeClient> => {
		const eventEmitter = mitt<Events>();

		const parsedOptions = realTimeClientConnectOptionsSchema.safeParse(options);
		if (!parsedOptions.success) {
			throw parsedOptions.error;
		}

		const sessionId = uuidv4();

		const { onRemoteStream, initialState } = parsedOptions.data;
		const webrtcManager = new WebRTCManager({
			webrtcUrl: `${baseUrl}/ws?gameTimeLimitSeconds=999999&model=${options.model.name}`,
			apiKey,
			sessionId,
			fps: options.model.fps,
			initialState,
			onRemoteStream,
			onConnectionStateChange: (
				state: "connected" | "connecting" | "disconnected",
			) => {
				eventEmitter.emit("connectionChange", state);
			},
			onError: (error) => {
				console.error("WebRTC error:", error);
				eventEmitter.emit("error", createWebrtcError(error));
			},
		});

		await webrtcManager.connect(stream);

		const methods = realtimeMethods(webrtcManager);

		return {
			enrichPrompt: methods.enrichPrompt,
			setPrompt: methods.setPrompt,
			setMirror: methods.setMirror,
			isConnected: () => webrtcManager.isConnected(),
			getConnectionState: () => webrtcManager.getConnectionState(),
			disconnect: () => webrtcManager.cleanup(),
			on: eventEmitter.on,
			off: eventEmitter.off,
			sessionId,
		};
	};

	return {
		connect,
	};
};
