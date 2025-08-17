import type {
	IncomingWebRTCMessage,
	InitializeSessionMessage,
	OutgoingWebRTCMessage,
} from "./types";

const ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

interface ConnectionCallbacks {
	onRemoteStream?: (stream: MediaStream) => void;
	onStateChange?: (state: ConnectionState) => void;
	onError?: (error: Error) => void;
}

export type ConnectionState = "connecting" | "connected" | "disconnected";

export class WebRTCConnection {
	private pc: RTCPeerConnection | null = null;
	private ws: WebSocket | null = null;
	private state: ConnectionState = "disconnected";

	constructor(private callbacks: ConnectionCallbacks = {}) {}

	async connect(
		url: string,
		localStream: MediaStream,
		initMessage: InitializeSessionMessage,
		timeout = 15000,
	): Promise<void> {
		const deadline = Date.now() + timeout;

		// Setup WebSocket
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error("WebSocket timeout")),
				timeout,
			);
			this.ws = new WebSocket(url);

			this.ws.onopen = () => {
				clearTimeout(timer);
				resolve();
			};
			this.ws.onmessage = (e) => {
				try {
					this.handleSignalingMessage(JSON.parse(e.data));
				} catch (err) {
					console.error("[WebRTC] Parse error:", err);
				}
			};
			this.ws.onerror = () => {
				clearTimeout(timer);
				reject(new Error("WebSocket failed"));
			};
			this.ws.onclose = () => this.setState("disconnected");
		});

		// Setup peer connection
		this.pc?.close();
		this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

		localStream
			.getTracks()
			.forEach((track) => this.pc!.addTrack(track, localStream));

		this.pc.ontrack = (e) => {
			if (e.streams?.[0]) this.callbacks.onRemoteStream?.(e.streams[0]);
		};

		this.pc.onicecandidate = (e) => {
			if (e.candidate)
				this.send({ type: "ice-candidate", candidate: e.candidate });
		};

		this.pc.onconnectionstatechange = () => {
			if (!this.pc) return;
			const s = this.pc.connectionState;
			this.setState(
				s === "connected"
					? "connected"
					: ["connecting", "new"].includes(s)
						? "connecting"
						: "disconnected",
			);
		};

		// Send init message and wait for connection
		this.send(initMessage);

		while (Date.now() < deadline) {
			if (this.state === "connected") return;
			await new Promise((r) => setTimeout(r, 100));
		}
		throw new Error("Connection timeout");
	}

	private async handleSignalingMessage(
		msg: IncomingWebRTCMessage,
	): Promise<void> {
		if (!this.pc) return;

		try {
			switch (msg.type) {
				case "ready": {
					const offer = await this.pc.createOffer();
					await this.pc.setLocalDescription(offer);
					this.send({ type: "offer", sdp: offer.sdp || "" });
					break;
				}
				case "offer": {
					await this.pc.setRemoteDescription({ type: "offer", sdp: msg.sdp });
					const answer = await this.pc.createAnswer();
					await this.pc.setLocalDescription(answer);
					this.send({ type: "answer", sdp: answer.sdp || "" });
					break;
				}
				case "answer":
					await this.pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
					break;
				case "ice-candidate":
					if (msg.candidate) await this.pc.addIceCandidate(msg.candidate);
					break;
			}
		} catch (error) {
			console.error("[WebRTC] Error:", error);
			this.callbacks.onError?.(error as Error);
		}
	}

	send(message: OutgoingWebRTCMessage): void {
		if (this.ws?.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify(message));
		}
	}

	private setState(state: ConnectionState): void {
		if (this.state !== state) {
			this.state = state;
			console.log(`[WebRTC] State: ${state}`);
			this.callbacks.onStateChange?.(state);
		}
	}

	cleanup(): void {
		this.pc?.getSenders().forEach((s) => s.track?.stop());
		this.pc?.close();
		this.pc = null;
		this.ws?.close();
		this.ws = null;
		this.setState("disconnected");
	}

	get connectionState(): ConnectionState {
		return this.state;
	}

	get isConnected(): boolean {
		return this.state === "connected";
	}
}
