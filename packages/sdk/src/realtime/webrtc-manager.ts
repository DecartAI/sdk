import pRetry, { AbortError } from "p-retry";
import type { RealTimeModels } from "../shared/model";
import type { Logger } from "../utils/logger";
import type { DiagnosticEmitter } from "./diagnostics";
import type { ConnectionState, OutgoingMessage } from "./types";
import { WebRTCConnection } from "./webrtc-connection";

export interface WebRTCConfig {
  webrtcUrl: string;
  integration?: string;
  logger?: Logger;
  onDiagnostic?: DiagnosticEmitter;
  onRemoteStream: (stream: MediaStream) => void;
  onConnectionStateChange?: (state: ConnectionState) => void;
  onError?: (error: Error) => void;
  customizeOffer?: (offer: RTCSessionDescriptionInit) => Promise<void>;
  vp8MinBitrate?: number;
  vp8StartBitrate?: number;
  modelName?: RealTimeModels;
  initialImage?: string;
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
  private logger: Logger;
  private localStream: MediaStream | null = null;
  private subscribeMode = false;
  private managerState: ConnectionState = "disconnected";
  private hasConnected = false;
  private isReconnecting = false;
  private intentionalDisconnect = false;
  private reconnectGeneration = 0;

  constructor(config: WebRTCConfig) {
    this.config = config;
    this.logger = config.logger ?? { debug() {}, info() {}, warn() {}, error() {} };
    this.connection = new WebRTCConnection({
      onRemoteStream: config.onRemoteStream,
      onStateChange: (state) => this.handleConnectionStateChange(state),
      onError: config.onError,
      customizeOffer: config.customizeOffer,
      vp8MinBitrate: config.vp8MinBitrate,
      vp8StartBitrate: config.vp8StartBitrate,
      modelName: config.modelName,
      initialImage: config.initialImage,
      initialPrompt: config.initialPrompt,
      logger: this.logger,
      onDiagnostic: config.onDiagnostic,
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
    if (this.isReconnecting || this.intentionalDisconnect) return;
    if (!this.subscribeMode && !this.localStream) return;

    const reconnectGeneration = ++this.reconnectGeneration;
    this.isReconnecting = true;
    this.emitState("reconnecting");
    const reconnectStart = performance.now();

    try {
      let attemptCount = 0;

      await pRetry(
        async () => {
          attemptCount++;

          if (this.intentionalDisconnect || reconnectGeneration !== this.reconnectGeneration) {
            throw new AbortError("Reconnect cancelled");
          }

          if (!this.subscribeMode && !this.localStream) {
            throw new AbortError("Reconnect cancelled: no local stream");
          }

          this.connection.cleanup();
          await this.connection.connect(
            this.config.webrtcUrl,
            this.localStream,
            CONNECTION_TIMEOUT,
            this.config.integration,
          );

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
            this.logger.warn("Reconnect attempt failed", { error: error.message, attempt: error.attemptNumber });
            this.config.onDiagnostic?.("reconnect", {
              attempt: error.attemptNumber,
              maxAttempts: RETRY_OPTIONS.retries,
              durationMs: performance.now() - reconnectStart,
              success: false,
              error: error.message,
            });
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
      this.config.onDiagnostic?.("reconnect", {
        attempt: attemptCount,
        maxAttempts: RETRY_OPTIONS.retries,
        durationMs: performance.now() - reconnectStart,
        success: true,
      });
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

  async connect(localStream: MediaStream | null): Promise<boolean> {
    this.localStream = localStream;
    this.subscribeMode = localStream === null;
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
          this.logger.warn("Connection attempt failed", { error: error.message, attempt: error.attemptNumber });
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

  getPeerConnection(): RTCPeerConnection | null {
    return this.connection.getPeerConnection();
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
