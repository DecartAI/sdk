import { buildUserAgent } from "../utils/user-agent";
import type {
	IncomingWebRTCMessage,
	OutgoingWebRTCMessage,
	TurnConfig,
} from "./types";

const ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

interface ConnectionCallbacks {
	onRemoteStream?: (stream: MediaStream) => void;
	onStateChange?: (state: ConnectionState) => void;
	onError?: (error: Error) => void;
	customizeOffer?: (offer: RTCSessionDescriptionInit) => Promise<void>;
	vp8MinBitrate?: number; // in Kbps, default: 200, set both to 0 to skip SDP modification
	vp8StartBitrate?: number; // in Kbps, default: 600, set both to 0 to skip SDP modification
}

export type ConnectionState = "connecting" | "connected" | "disconnected";

export class WebRTCConnection {
	private pc: RTCPeerConnection | null = null;
	private ws: WebSocket | null = null;
	private localStream: MediaStream | null = null;
	private connectionReject: ((error: Error) => void) | null = null;
	state: ConnectionState = "disconnected";

	constructor(private callbacks: ConnectionCallbacks = {}) {}

	async connect(
		url: string,
		localStream: MediaStream,
		timeout = 35000,
		integration?: string,
	): Promise<void> {
		const deadline = Date.now() + timeout;
		this.localStream = localStream;

		// Add user agent as query parameter (browsers don't support WS headers)
		const userAgent = encodeURIComponent(buildUserAgent(integration));
		const separator = url.includes("?") ? "&" : "?";
		const wsUrl = `${url}${separator}user_agent=${userAgent}`;

		// Setup WebSocket
		await new Promise<void>((resolve, reject) => {
			this.connectionReject = reject;
			const timer = setTimeout(
				() => reject(new Error("WebSocket timeout")),
				timeout,
			);
			this.ws = new WebSocket(wsUrl);

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
				// reject(new Error("WebSocket failed"));
			};
			this.ws.onclose = () => this.setState("disconnected");
		});

		await this.setupNewPeerConnection();

		return new Promise<void>((resolve, reject) => {
			this.connectionReject = reject;
			const checkConnection = setInterval(() => {
				if (this.state === "connected") {
					clearInterval(checkConnection);
					this.connectionReject = null;
					resolve();
				} else if (Date.now() >= deadline) {
					clearInterval(checkConnection);
					this.connectionReject = null;
					reject(new Error("Connection timeout"));
				}
			}, 100);
		});
	}

	private async handleSignalingMessage(
		msg: IncomingWebRTCMessage,
	): Promise<void> {
		if (!this.pc) return;

		try {
			switch (msg.type) {
				case "error": {
					const error = new Error(msg.error);
					this.callbacks.onError?.(error);
					if (this.connectionReject) {
						this.connectionReject(error);
						this.connectionReject = null;
					}
					break;
				}
				case "ready": {
					await this.applyCodecPreference("video/VP8");
					const offer = await this.pc.createOffer();
					this.modifyVP8Bitrate(offer);
					await this.callbacks.customizeOffer?.(offer);
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
					await this.pc.setRemoteDescription({
						type: "answer",
						sdp: msg.sdp,
					});
					break;
				case "ice-candidate":
					if (msg.candidate) await this.pc.addIceCandidate(msg.candidate);
					break;
				case "ice-restart": {
					const turnConfig = msg.turn_config;
					if (turnConfig) {
						await this.setupNewPeerConnection(turnConfig);
					}
					break;
				}
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

	private async setupNewPeerConnection(turnConfig?: TurnConfig): Promise<void> {
		if (!this.localStream) {
			throw new Error("No local stream found");
		}
		if (this.pc) {
			this.pc.getSenders().forEach((sender) => {
				if (sender.track) {
					this.pc!.removeTrack(sender);
				}
			});
			this.pc.close();
		}
		const iceServers: RTCIceServer[] = ICE_SERVERS;
		if (turnConfig) {
			iceServers.push({
				urls: turnConfig.server_url,
				credential: turnConfig.credential,
				username: turnConfig.username,
			});
		}
		this.pc = new RTCPeerConnection({ iceServers });

		this.localStream
			.getTracks()
			.forEach((track) => this.pc!.addTrack(track, this.localStream!));

		this.pc.ontrack = (e) => {
			if (e.streams?.[0]) this.callbacks.onRemoteStream?.(e.streams[0]);
		};

		this.pc.onicecandidate = (e) => {
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

		this.pc.oniceconnectionstatechange = () => {};

		this.handleSignalingMessage({ type: "ready" });
	}

	cleanup(): void {
		this.pc?.getSenders().forEach((s) => s.track?.stop());
		this.pc?.close();
		this.pc = null;
		this.ws?.close();
		this.ws = null;
		this.localStream = null;
		this.setState("disconnected");
	}

	async applyCodecPreference(preferredCodecName: "video/VP8" | "video/H264") {
		if (!this.pc) return;

		const videoTransceiver = this.pc
			.getTransceivers()
			.find((r) => r.sender.track?.kind === "video");
		if (!videoTransceiver) {
			console.error(
				"Could not find video transceiver. Ensure track is added to peer connection.",
			);
			return;
		}

		const capabilities = RTCRtpSender.getCapabilities("video");
		if (!capabilities) {
			console.error("Could not get video sender capabilities.");
			return;
		}

		const preferredCodecs: RTCRtpCodec[] = [];
		const otherCodecs: RTCRtpCodec[] = [];
		capabilities.codecs.forEach((codec) => {
			if (codec.mimeType.toLowerCase() === preferredCodecName.toLowerCase()) {
				preferredCodecs.push(codec);
			} else {
				otherCodecs.push(codec);
			}
		});

		const orderedCodecs = [...preferredCodecs, ...otherCodecs];
		if (orderedCodecs.length === 0) {
			console.warn("No video codecs found to set preferences for.");
			return;
		}
		await videoTransceiver.setCodecPreferences(orderedCodecs);
	}

	private modifyVP8Bitrate(offer: RTCSessionDescriptionInit): void {
		if (!offer.sdp) return;

		const minBitrate = this.callbacks.vp8MinBitrate ?? 200;
		const startBitrate = this.callbacks.vp8StartBitrate ?? 600;

		// Skip modification if both are explicitly set to 0
		if (minBitrate === 0 && startBitrate === 0) {
			return;
		}

		const bitrateParams = `x-google-min-bitrate=${minBitrate};x-google-start-bitrate=${startBitrate}`;

		const sdpLines = offer.sdp.split("\r\n");
		const modifiedLines: string[] = [];

		for (let i = 0; i < sdpLines.length; i++) {
			// Look for VP8 codec line (e.g., "a=rtpmap:96 VP8/90000")
			if (sdpLines[i].includes("VP8/90000")) {
				const match = sdpLines[i].match(/a=rtpmap:(\d+) VP8/);
				if (match) {
					const payloadType = match[1];

					// Find the range of lines for this payload type and where to insert fmtp
					let fmtpIndex = -1;
					let insertAfterIndex = i;  // Default: insert after rtpmap line

					for (let j = i + 1; j < sdpLines.length && sdpLines[j].startsWith("a="); j++) {
						// Check if fmtp already exists
						if (sdpLines[j].startsWith(`a=fmtp:${payloadType}`)) {
							fmtpIndex = j;
							break;
						}
						// Update insert position to after rtcp-fb lines for this payload
						if (sdpLines[j].startsWith(`a=rtcp-fb:${payloadType}`)) {
							insertAfterIndex = j;
						}
						// Stop at next rtpmap (different codec)
						if (sdpLines[j].startsWith("a=rtpmap:")) {
							break;
						}
					}

					if (fmtpIndex !== -1) {
						// fmtp line exists, modify it in place
						if (!sdpLines[fmtpIndex].includes("x-google-min-bitrate")) {
							sdpLines[fmtpIndex] += `;${bitrateParams}`;
						}
					} else {
						// No fmtp line exists, we'll insert it after all rtcp-fb lines
						// Push lines up to and including the insert position
						for (let k = i; k <= insertAfterIndex; k++) {
							modifiedLines.push(sdpLines[k]);
						}
						// Insert the new fmtp line
						modifiedLines.push(`a=fmtp:${payloadType} ${bitrateParams}`);
						// Skip to after the insert position
						i = insertAfterIndex;
						continue;
					}
				}
			}
			modifiedLines.push(sdpLines[i]);
		}

		offer.sdp = modifiedLines.join("\r\n");
	}
}
