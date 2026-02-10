import pRetry, { AbortError } from "p-retry";
import type { ConnectionState, OutgoingMessage } from "./types";
import { WebRTCConnection } from "./webrtc-connection";

export interface WebRTCConfig {
  webrtcUrl: string;
  integration?: string;
  onRemoteStream: (stream: MediaStream) => void;
  onConnectionStateChange?: (state: ConnectionState) => void;
  onError?: (error: Error) => void;
  customizeOffer?: (offer: RTCSessionDescriptionInit) => Promise<void>;
  vp8MinBitrate?: number;
  vp8StartBitrate?: number;
  isAvatarLive?: boolean;
  avatarImageBase64?: string;
  initialPrompt?: { text: string; enhance?: boolean };
}

const PERMANENT_ERRORS = [
  "permission denied",
  "not allowed",
  "invalid session",
  "401",
  "invalid api key",
  "unauthorized",
];

const CONNECTION_TIMEOUT = 60_000 * 5; // 5 minutes

const RETRY_OPTIONS = {
  retries: 5,
  factor: 2,
  minTimeout: 1000,
  maxTimeout: 10000,
} as const;

export class WebRTCManager {
  private connection: WebRTCConnection;
  private config: WebRTCConfig;
  private localStream: MediaStream | null = null;
  private managerState: ConnectionState = "disconnected";
  private hasConnected = false;
  private isReconnecting = false;
  private intentionalDisconnect = false;
  private reconnectGeneration = 0;

  constructor(config: WebRTCConfig) {
    this.config = config;
    this.connection = new WebRTCConnection({
      onRemoteStream: config.onRemoteStream,
      onStateChange: (state) => this.handleConnectionStateChange(state),
      onError: config.onError,
      customizeOffer: config.customizeOffer,
      vp8MinBitrate: config.vp8MinBitrate,
      vp8StartBitrate: config.vp8StartBitrate,
      isAvatarLive: config.isAvatarLive,
      avatarImageBase64: config.avatarImageBase64,
      initialPrompt: config.initialPrompt,
    });
  }

  private emitState(state: ConnectionState): void {
    if (this.managerState !== state) {
      this.managerState = state;
      if (state === "connected" || state === "generating") this.hasConnected = true;
      this.config.onConnectionStateChange?.(state);
    }
  }

  private handleConnectionStateChange(state: ConnectionState): void {
    if (this.intentionalDisconnect) {
      this.emitState("disconnected");
      return;
    }

    // During reconnection, intercept state changes from the connection layer
    if (this.isReconnecting) {
      if (state === "connected" || state === "generating") {
        this.isReconnecting = false;
        this.emitState(state);
      }
      return;
    }

    // Unexpected disconnect after having been connected → trigger auto-reconnect
    // hasConnected guards against triggering during initial connect (which has its own retry loop)
    if (state === "disconnected" && !this.intentionalDisconnect && this.hasConnected) {
      this.reconnect();
      return;
    }

    this.emitState(state);
  }

  private async reconnect(): Promise<void> {
    if (this.isReconnecting || this.intentionalDisconnect || !this.localStream) return;

    const reconnectGeneration = ++this.reconnectGeneration;
    this.isReconnecting = true;
    this.emitState("reconnecting");

    try {
      await pRetry(
        async () => {
          if (this.intentionalDisconnect || reconnectGeneration !== this.reconnectGeneration) {
            throw new AbortError("Reconnect cancelled");
          }

          const stream = this.localStream;
          if (!stream) {
            throw new AbortError("Reconnect cancelled: no local stream");
          }

          this.connection.cleanup();
          await this.connection.connect(this.config.webrtcUrl, stream, CONNECTION_TIMEOUT, this.config.integration);

          if (this.intentionalDisconnect || reconnectGeneration !== this.reconnectGeneration) {
            this.connection.cleanup();
            throw new AbortError("Reconnect cancelled");
          }
        },
        {
          ...RETRY_OPTIONS,
          onFailedAttempt: (error) => {
            if (this.intentionalDisconnect || reconnectGeneration !== this.reconnectGeneration) {
              return;
            }
            console.error(`[WebRTC] Reconnect attempt failed: ${error.message}`);
            this.connection.cleanup();
          },
          shouldRetry: (error) => {
            if (this.intentionalDisconnect || reconnectGeneration !== this.reconnectGeneration) {
              return false;
            }
            const msg = error.message.toLowerCase();
            return !PERMANENT_ERRORS.some((err) => msg.includes(err));
          },
        },
      );
      // "connected" state is emitted by handleConnectionStateChange
    } catch (error) {
      this.isReconnecting = false;
      if (this.intentionalDisconnect || reconnectGeneration !== this.reconnectGeneration) {
        return;
      }
      this.emitState("disconnected");
      this.config.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async connect(localStream: MediaStream): Promise<boolean> {
    this.localStream = localStream;
    this.intentionalDisconnect = false;
    this.hasConnected = false;
    this.isReconnecting = false;
    this.reconnectGeneration += 1;
    this.emitState("connecting");

    return pRetry(
      async () => {
        if (this.intentionalDisconnect) {
          throw new AbortError("Connect cancelled");
        }
        await this.connection.connect(this.config.webrtcUrl, localStream, CONNECTION_TIMEOUT, this.config.integration);
        return true;
      },
      {
        ...RETRY_OPTIONS,
        onFailedAttempt: (error) => {
          console.error(`[WebRTC] Failed to connect: ${error.message}`);
          this.connection.cleanup();
        },
        shouldRetry: (error) => {
          if (this.intentionalDisconnect) {
            return false;
          }
          const msg = error.message.toLowerCase();
          return !PERMANENT_ERRORS.some((err) => msg.includes(err));
        },
      },
    );
  }

  sendMessage(message: OutgoingMessage): boolean {
    return this.connection.send(message);
  }

  cleanup(): void {
    this.intentionalDisconnect = true;
    this.isReconnecting = false;
    this.reconnectGeneration += 1;
    this.connection.cleanup();
    this.localStream = null;
    this.emitState("disconnected");
  }

  isConnected(): boolean {
    return this.managerState === "connected" || this.managerState === "generating";
  }

  getConnectionState(): ConnectionState {
    return this.managerState;
  }

  getWebsocketMessageEmitter() {
    return this.connection.websocketMessagesEmitter;
  }

  setImage(
    imageBase64: string | null,
    options?: { prompt?: string; enhance?: boolean; timeout?: number },
  ): Promise<void> {
    return this.connection.setImageBase64(imageBase64, options);
  }
}
