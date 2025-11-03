import pRetry from "p-retry";
import type { RealTimeClientInitialState } from "./client";
import type { OutgoingMessage } from "./types";
import { WebRTCConnection } from "./webrtc-connection";

export interface WebRTCConfig {
	webrtcUrl: string;
	apiKey: string;
	sessionId: string;
	fps: number;
	integration?: string;
	onRemoteStream: (stream: MediaStream) => void;
	onConnectionStateChange?: (
		state: "connected" | "connecting" | "disconnected",
	) => void;
	onError?: (error: Error) => void;
	initialState?: RealTimeClientInitialState;
	customizeOffer?: (offer: RTCSessionDescriptionInit) => Promise<void>;
}

const PERMANENT_ERRORS = [
	"permission denied",
	"not allowed",
	"invalid session",
	"401",
	"invalid api key",
	"unauthorized",
];

export class WebRTCManager {
	private connection: WebRTCConnection;
	private config: WebRTCConfig;

	constructor(config: WebRTCConfig) {
		this.config = config;
		this.connection = new WebRTCConnection({
			onRemoteStream: config.onRemoteStream,
			onStateChange: config.onConnectionStateChange,
			onError: config.onError,
			customizeOffer: config.customizeOffer,
		});
	}

	async connect(localStream: MediaStream): Promise<boolean> {
		return pRetry(
			async () => {
				await this.connection.connect(
					this.config.webrtcUrl,
					localStream,
					25000,
					this.config.integration,
				);
				return true;
			},
			{
				retries: 5,
				factor: 2,
				minTimeout: 1000,
				maxTimeout: 10000,
				onFailedAttempt: (error) => {
					console.error(`[WebRTC] Failed to connect: ${error.message}`);
					this.connection.cleanup();
				},
				shouldRetry: (error) => {
					const msg = error.message.toLowerCase();
					return !PERMANENT_ERRORS.some((err) => msg.includes(err));
				},
			},
		);
	}

	sendMessage(message: OutgoingMessage): void {
		this.connection.send(message);
	}

	cleanup(): void {
		this.connection.cleanup();
	}

	isConnected(): boolean {
		return this.connection.state === "connected";
	}

	getConnectionState(): "connected" | "connecting" | "disconnected" {
		return this.connection.state;
	}
}
