import pRetry from "p-retry";
import type { RealTimeClientInitialState } from "./client";
import type { OutgoingMessage, SessionInfo } from "./types";
import { WebRTCConnection } from "./webrtc-connection";

export interface WebRTCConfig {
  webrtcUrl: string;
  apiKey: string;
  sessionId: string;
  fps: number;
  integration?: string;
  onRemoteStream: (stream: MediaStream) => void;
  onConnectionStateChange?: (state: "connected" | "connecting" | "disconnected") => void;
  onError?: (error: Error) => void;
  initialState?: RealTimeClientInitialState;
  customizeOffer?: (offer: RTCSessionDescriptionInit) => Promise<void>;
  vp8MinBitrate?: number;
  vp8StartBitrate?: number;
  isAvatarLive?: boolean;
  avatarImageBase64?: string;
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
      vp8MinBitrate: config.vp8MinBitrate,
      vp8StartBitrate: config.vp8StartBitrate,
      isAvatarLive: config.isAvatarLive,
      avatarImageBase64: config.avatarImageBase64,
    });
  }

  async connect(localStream: MediaStream): Promise<boolean> {
    return pRetry(
      async () => {
        await this.connection.connect(this.config.webrtcUrl, localStream, 60000, this.config.integration);
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

  getWebsocketMessageEmitter() {
    return this.connection.websocketMessagesEmitter;
  }

  setImage(imageBase64: string): Promise<void> {
    return this.connection.setImageBase64(imageBase64);
  }
  getSessionInfo(): SessionInfo | null {
    return this.connection.sessionInfo;
  }
}
