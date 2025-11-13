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
	integration?: string;
};

const realTimeClientInitialStateSchema = modelStateSchema;
type OnRemoteStreamFn = (stream: MediaStream) => void;
export type RealTimeClientInitialState = z.infer<
	typeof realTimeClientInitialStateSchema
>;

// ugly workaround to add an optional function to the schema
// https://github.com/colinhacks/zod/issues/4143#issuecomment-2845134912
const createAsyncFunctionSchema = <T extends z.core.$ZodFunction>(schema: T) =>
	z.custom<Parameters<T["implementAsync"]>[0]>((fn) =>
		schema.implementAsync(fn as any),
	);

const realTimeClientConnectOptionsSchema = z.object({
	model: modelDefinitionSchema,
	onRemoteStream: z.custom<OnRemoteStreamFn>(
		(val) => typeof val === "function",
		{ message: "onRemoteStream must be a function" },
	),
	initialState: realTimeClientInitialStateSchema.optional(),
	customizeOffer: createAsyncFunctionSchema(z.function()).optional(),
	vp8MinBitrate: z.number().optional(),
	vp8StartBitrate: z.number().optional(),
});
export type RealTimeClientConnectOptions = z.infer<
	typeof realTimeClientConnectOptionsSchema
>;

export type Events = {
	connectionChange: "connected" | "connecting" | "disconnected";
	error: DecartSDKError;
};

export type RealTimeClient = {
	setPrompt: (prompt: string, { enhance }?: { enhance?: boolean }) => void;
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
	const { baseUrl, apiKey, integration } = opts;

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

		const url = `${baseUrl}${options.model.urlPath}`;
		const webrtcManager = new WebRTCManager({
			webrtcUrl: `${url}?api_key=${apiKey}&model=${options.model.name}`,
			apiKey,
			sessionId,
			fps: options.model.fps,
			initialState,
			integration,
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
			customizeOffer: options.customizeOffer as
				| ((offer: RTCSessionDescriptionInit) => Promise<void>)
				| undefined,
			vp8MinBitrate: options.vp8MinBitrate,
			vp8StartBitrate: options.vp8StartBitrate,
		});

		await webrtcManager.connect(stream);

		const methods = realtimeMethods(webrtcManager);

		if (options.initialState) {
			if (options.initialState.prompt) {
				const { text, enhance } = options.initialState.prompt;
				methods.setPrompt(text, { enhance });
			}
			if (options.initialState.mirror) {
				methods.setMirror(options.initialState.mirror);
			}
		}

		return {
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
