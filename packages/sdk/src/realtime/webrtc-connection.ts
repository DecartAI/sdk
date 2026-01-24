import mitt from "mitt";
import { buildUserAgent } from "../utils/user-agent";
import type {
  IncomingWebRTCMessage,
  OutgoingWebRTCMessage,
  PromptAckMessage,
  SetImageAckMessage,
  TurnConfig,
} from "./types";

const ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];
const AVATAR_SETUP_TIMEOUT_MS = 15000;

interface ConnectionCallbacks {
  onRemoteStream?: (stream: MediaStream) => void;
  onStateChange?: (state: ConnectionState) => void;
  onError?: (error: Error) => void;
  customizeOffer?: (offer: RTCSessionDescriptionInit) => Promise<void>;
  vp8MinBitrate?: number;
  vp8StartBitrate?: number;
  isAvatarLive?: boolean;
  avatarImageBase64?: string;
  initialPrompt?: { text: string; enhance?: boolean };
}

export type ConnectionState = "connecting" | "connected" | "disconnected";

type WsMessageEvents = {
  promptAck: PromptAckMessage;
  setImageAck: SetImageAckMessage;
};

export class WebRTCConnection {
  private pc: RTCPeerConnection | null = null;
  private ws: WebSocket | null = null;
  private localStream: MediaStream | null = null;
  private connectionReject: ((error: Error) => void) | null = null;
  state: ConnectionState = "disconnected";
  websocketMessagesEmitter = mitt<WsMessageEvents>();
  constructor(private callbacks: ConnectionCallbacks = {}) {}

  async connect(url: string, localStream: MediaStream, timeout = 60000, integration?: string): Promise<void> {
    const deadline = Date.now() + timeout;
    this.localStream = localStream;

    // Add user agent as query parameter (browsers don't support WS headers)
    const userAgent = encodeURIComponent(buildUserAgent(integration));
    const separator = url.includes("?") ? "&" : "?";
    const wsUrl = `${url}${separator}user_agent=${userAgent}`;

    // Setup WebSocket
    await new Promise<void>((resolve, reject) => {
      this.connectionReject = reject;
      const timer = setTimeout(() => reject(new Error("WebSocket timeout")), timeout);
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
      };
      this.ws.onclose = () => this.setState("disconnected");
    });

    // For live_avatar: send avatar image before WebRTC handshake
    if (this.callbacks.avatarImageBase64) {
      await this.sendAvatarImage(this.callbacks.avatarImageBase64);
    }

    // Send initial prompt before WebRTC handshake
    if (this.callbacks.initialPrompt) {
      await this.sendInitialPrompt(this.callbacks.initialPrompt);
    }

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

  private async handleSignalingMessage(msg: IncomingWebRTCMessage): Promise<void> {
    try {
      // Handle messages that don't require peer connection first
      if (msg.type === "error") {
        const error = new Error(msg.error);
        this.callbacks.onError?.(error);
        if (this.connectionReject) {
          this.connectionReject(error);
          this.connectionReject = null;
        }
        return;
      }

      if (msg.type === "set_image_ack") {
        this.websocketMessagesEmitter.emit("setImageAck", msg);
        return;
      }

      if (msg.type === "prompt_ack") {
        this.websocketMessagesEmitter.emit("promptAck", msg);
        return;
      }

      // All other messages require peer connection
      if (!this.pc) return;

      switch (msg.type) {
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

  private async sendAvatarImage(imageBase64: string): Promise<void> {
    return this.setImageBase64(imageBase64);
  }

  /**
   * Send an image to the server (e.g., as a reference for inference).
   * Can be called after connection is established.
   * Pass null to clear the reference image or use a placeholder.
   * Optionally include a prompt to send with the image.
   */
  async setImageBase64(imageBase64: string | null, options?: { prompt?: string; enhance?: boolean }): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.websocketMessagesEmitter.off("setImageAck", listener);
        reject(new Error("Image send timed out"));
      }, AVATAR_SETUP_TIMEOUT_MS);

      const listener = (msg: SetImageAckMessage) => {
        clearTimeout(timeoutId);
        this.websocketMessagesEmitter.off("setImageAck", listener);
        if (msg.success) {
          resolve();
        } else {
          reject(new Error(msg.error ?? "Failed to send image"));
        }
      };

      this.websocketMessagesEmitter.on("setImageAck", listener);

      const message: { type: "set_image"; image_data: string | null; prompt?: string; enhance_prompt?: boolean } = {
        type: "set_image",
        image_data: imageBase64,
      };

      if (options?.prompt !== undefined) {
        message.prompt = options.prompt;
      }
      if (options?.enhance !== undefined) {
        message.enhance_prompt = options.enhance;
      }

      this.send(message);
    });
  }

  /**
   * Send the initial prompt to the server before WebRTC handshake.
   */
  private async sendInitialPrompt(prompt: { text: string; enhance?: boolean }): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.websocketMessagesEmitter.off("promptAck", listener);
        reject(new Error("Prompt send timed out"));
      }, AVATAR_SETUP_TIMEOUT_MS);

      const listener = (msg: PromptAckMessage) => {
        if (msg.prompt === prompt.text) {
          clearTimeout(timeoutId);
          this.websocketMessagesEmitter.off("promptAck", listener);
          if (msg.success) {
            resolve();
          } else {
            reject(new Error(msg.error ?? "Failed to send prompt"));
          }
        }
      };

      this.websocketMessagesEmitter.on("promptAck", listener);
      this.send({ type: "prompt", prompt: prompt.text, enhance_prompt: prompt.enhance ?? true });
    });
  }

  private setState(state: ConnectionState): void {
    if (this.state !== state) {
      this.state = state;
      this.callbacks.onStateChange?.(state);
    }
  }

  private async setupNewPeerConnection(turnConfig?: TurnConfig): Promise<void> {
    if (!this.localStream) {
      throw new Error("No local stream found");
    }
    if (this.pc) {
      this.pc.getSenders().forEach((sender) => {
        if (sender.track && this.pc) {
          this.pc.removeTrack(sender);
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

    // For live_avatar: add receive-only video transceiver (sends audio only, receives audio+video)
    if (this.callbacks.isAvatarLive) {
      this.pc.addTransceiver("video", { direction: "recvonly" });
    }

    this.localStream.getTracks().forEach((track) => {
      if (this.pc && this.localStream) {
        this.pc.addTrack(track, this.localStream);
      }
    });

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
        s === "connected" ? "connected" : ["connecting", "new"].includes(s) ? "connecting" : "disconnected",
      );
    };

    this.pc.oniceconnectionstatechange = () => {};

    this.handleSignalingMessage({ type: "ready" });
  }

  cleanup(): void {
    // Note: We intentionally do NOT stop the tracks here.
    // The tracks belong to the user's source stream, not the SDK.
    // Stopping them would break retries and local preview.
    //TODO: Think of this more carefully.
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
      .find((r) => r.sender.track?.kind === "video" || r.receiver.track?.kind === "video");
    if (!videoTransceiver) {
      console.error("Could not find video transceiver. Ensure track is added to peer connection.");
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

    const minBitrateInKbps = this.callbacks.vp8MinBitrate;
    const startBitrateInKbps = this.callbacks.vp8StartBitrate;

    if (minBitrateInKbps === 0 && startBitrateInKbps === 0) {
      return;
    }

    const bitrateParams = `x-google-min-bitrate=${minBitrateInKbps};x-google-start-bitrate=${startBitrateInKbps}`;

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
          let insertAfterIndex = i; // Default: insert after rtpmap line

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
