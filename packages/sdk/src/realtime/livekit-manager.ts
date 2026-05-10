import pRetry, { AbortError } from "p-retry";

import { LiveKitConnection } from "./livekit-connection";
import type { RealtimeObservability } from "./observability/realtime-observability";
import type { ConnectionChangeDetails, ConnectionState, OutgoingMessage, QueuePosition } from "./types";

export interface LiveKitConfig {
  url: string;
  integration?: string;
  observability?: RealtimeObservability;
  onRemoteStream: (stream: MediaStream) => void;
  onConnectionStateChange?: (state: ConnectionState, details?: ConnectionChangeDetails) => void;
  onQueuePosition?: (queuePosition: QueuePosition) => void;
  onError?: (error: Error) => void;
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

type ConnectionStatus =
  | { status: "idle" }
  | { status: "connecting"; queued: boolean }
  | { status: "connected" }
  | { status: "reconnecting"; generation: number; queued: boolean }
  | { status: "disposed" };

export class LiveKitManager {
  private connection: LiveKitConnection;
  private config: LiveKitConfig;
  private localStream: MediaStream | null = null;
  private subscribeMode = false;
  private managerState: ConnectionState = "disconnected";
  private connectionStatus: ConnectionStatus = { status: "idle" };
  private reconnectGenerationCounter = 0;

  constructor(config: LiveKitConfig) {
    this.config = config;
    this.connection = new LiveKitConnection({
      onRemoteStream: config.onRemoteStream,
      onStateChange: (state: ConnectionState, details?: ConnectionChangeDetails) =>
        this.handleConnectionStateChange(state, details),
      onQueuePosition: config.onQueuePosition,
      onError: config.onError,
      initialImage: config.initialImage,
      initialPrompt: config.initialPrompt,
      observability: config.observability,
    });
  }

  private emitState(state: ConnectionState, details?: ConnectionChangeDetails): void {
    const shouldEmit = this.managerState !== state || (state === "pending" && details?.queuePosition !== undefined);
    if (shouldEmit) {
      this.managerState = state;
      this.config.onConnectionStateChange?.(state, details);
    }
  }

  private handleConnectionStateChange(state: ConnectionState, details?: ConnectionChangeDetails): void {
    if (this.connectionStatus.status === "disposed") {
      this.emitState("disconnected");
      return;
    }

    if (
      state === "pending" &&
      (this.connectionStatus.status === "connecting" || this.connectionStatus.status === "reconnecting")
    ) {
      this.connectionStatus.queued = true;
    } else if (
      state === "connecting" &&
      (this.connectionStatus.status === "connecting" || this.connectionStatus.status === "reconnecting")
    ) {
      this.connectionStatus.queued = false;
    }

    if (this.connectionStatus.status === "reconnecting") {
      if (state === "connected" || state === "generating" || state === "pending") {
        this.emitState(state, details);
      }
      return;
    }

    if (state === "disconnected" && this.isConnected()) {
      this.reconnect();
      return;
    }

    this.emitState(state, details);
  }

  private async reconnect(): Promise<void> {
    if (this.connectionStatus.status === "reconnecting" || this.connectionStatus.status === "disposed") return;
    if (!this.subscribeMode && !this.localStream) return;

    const generation = ++this.reconnectGenerationCounter;
    const myStatus = { status: "reconnecting" as const, generation, queued: false };
    this.connectionStatus = myStatus;
    this.emitState("reconnecting");

    try {
      await pRetry(
        async () => {
          if (this.connectionStatus !== myStatus) {
            throw new AbortError("Reconnect cancelled");
          }
          myStatus.queued = false;

          if (!this.subscribeMode && !this.localStream) {
            throw new AbortError("Reconnect cancelled: no local stream");
          }

          this.connection.cleanup();
          await this.connection.connect(this.config.url, this.localStream, CONNECTION_TIMEOUT, this.config.integration);

          if (this.connectionStatus !== myStatus) {
            this.connection.cleanup();
            throw new AbortError("Reconnect cancelled");
          }
        },
        {
          ...RETRY_OPTIONS,
          onFailedAttempt: () => {
            this.connection.cleanup();
          },
          shouldRetry: (error) => {
            if (this.connectionStatus !== myStatus || myStatus.queued) return false;
            const msg = error.message.toLowerCase();
            return !PERMANENT_ERRORS.some((err) => msg.includes(err));
          },
        },
      );
      if (this.connectionStatus === myStatus) {
        this.connectionStatus = { status: "connected" };
      }
    } catch (error) {
      if (this.connectionStatus !== myStatus) return;
      this.connectionStatus = { status: "idle" };
      this.emitState("disconnected");
      this.config.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async connect(localStream: MediaStream | null): Promise<boolean> {
    this.localStream = localStream;
    this.subscribeMode = localStream === null;
    const myStatus = { status: "connecting" as const, queued: false };
    this.connectionStatus = myStatus;
    this.emitState("connecting");

    try {
      const result = await pRetry(
        async () => {
          if (this.connectionStatus !== myStatus) {
            throw new AbortError("Connect cancelled");
          }
          myStatus.queued = false;
          await this.connection.connect(this.config.url, localStream, CONNECTION_TIMEOUT, this.config.integration);
          return true;
        },
        {
          ...RETRY_OPTIONS,
          onFailedAttempt: () => {
            this.connection.cleanup();
          },
          shouldRetry: (error) => {
            if (this.connectionStatus !== myStatus || myStatus.queued) return false;
            const msg = error.message.toLowerCase();
            return !PERMANENT_ERRORS.some((err) => msg.includes(err));
          },
        },
      );
      if (this.connectionStatus === myStatus) {
        this.connectionStatus = { status: "connected" };
      }
      return result;
    } catch (error) {
      if (this.connectionStatus === myStatus) {
        this.connectionStatus = { status: "idle" };
      }
      throw error;
    }
  }

  sendMessage(message: OutgoingMessage): boolean {
    return this.connection.send(message);
  }

  cleanup(): void {
    this.connectionStatus = { status: "disposed" };
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
