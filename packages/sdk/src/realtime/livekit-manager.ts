import pRetry, { AbortError } from "p-retry";

import type { Logger } from "../utils/logger";
import type { DiagnosticEmitter } from "./diagnostics";
import { LiveKitConnection } from "./livekit-connection";
import type { ConnectionState, OutgoingMessage, QueuePosition } from "./types";
import type { StatsProvider } from "./webrtc-stats";

export interface LiveKitConfig {
  url: string;
  integration?: string;
  logger?: Logger;
  onDiagnostic?: DiagnosticEmitter;
  onRemoteStream: (stream: MediaStream) => void;
  onConnectionStateChange?: (state: ConnectionState) => void;
  onQueuePosition?: (queuePosition: QueuePosition) => void;
  onError?: (error: Error) => void;
  modelName?: string;
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

const MAX_ATTEMPTS = RETRY_OPTIONS.retries + 1;

type ConnectionStatus =
  | { status: "idle" }
  | { status: "connecting"; queued: boolean }
  | { status: "connected" }
  | { status: "reconnecting"; generation: number; queued: boolean }
  | { status: "disposed" };

function sanitizeUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.searchParams.has("api_key")) u.searchParams.set("api_key", "***");
    return u.toString();
  } catch {
    return url.replace(/api_key=[^&]*/g, "api_key=***");
  }
}

export class LiveKitManager {
  private connection: LiveKitConnection;
  private config: LiveKitConfig;
  private logger: Logger;
  private localStream: MediaStream | null = null;
  private subscribeMode = false;
  private managerState: ConnectionState = "disconnected";
  private connectionStatus: ConnectionStatus = { status: "idle" };
  private reconnectGenerationCounter = 0;

  constructor(config: LiveKitConfig) {
    this.config = config;
    this.logger = config.logger ?? { debug() {}, info() {}, warn() {}, error() {} };
    this.connection = new LiveKitConnection({
      onRemoteStream: config.onRemoteStream,
      onStateChange: (state: ConnectionState) => this.handleConnectionStateChange(state),
      onQueuePosition: config.onQueuePosition,
      onError: config.onError,
      modelName: config.modelName,
      initialImage: config.initialImage,
      initialPrompt: config.initialPrompt,
      logger: this.logger,
      onDiagnostic: config.onDiagnostic,
    });
    this.logger.info("LiveKit realtime selected", {
      modelName: config.modelName ?? null,
      url: sanitizeUrl(config.url),
      hasInitialImage: Boolean(config.initialImage),
      hasInitialPrompt: Boolean(config.initialPrompt),
      integration: config.integration ?? null,
    });
  }

  private emitState(state: ConnectionState): void {
    if (this.managerState !== state) {
      this.logger.debug("LiveKit manager state changed", {
        previousState: this.managerState,
        state,
        modelName: this.config.modelName ?? null,
        subscribeMode: this.subscribeMode,
        connectionStatus: this.connectionStatus.status,
      });
      this.managerState = state;
      this.config.onConnectionStateChange?.(state);
    }
  }

  private handleConnectionStateChange(state: ConnectionState): void {
    if (this.connectionStatus.status === "disposed") {
      this.emitState("disconnected");
      return;
    }

    if (
      state === "pending" &&
      (this.connectionStatus.status === "connecting" || this.connectionStatus.status === "reconnecting")
    ) {
      this.connectionStatus.queued = true;
    }

    if (this.connectionStatus.status === "reconnecting") {
      if (state === "connected" || state === "generating" || state === "pending") {
        this.emitState(state);
      }
      return;
    }

    if (state === "disconnected" && this.isConnected()) {
      this.logger.debug("LiveKit manager starting reconnect after unexpected disconnect", {
        modelName: this.config.modelName ?? null,
        subscribeMode: this.subscribeMode,
      });
      this.reconnect();
      return;
    }

    this.emitState(state);
  }

  private async reconnect(): Promise<void> {
    if (this.connectionStatus.status === "reconnecting" || this.connectionStatus.status === "disposed") return;
    if (!this.subscribeMode && !this.localStream) return;

    const generation = ++this.reconnectGenerationCounter;
    const myStatus = { status: "reconnecting" as const, generation, queued: false };
    this.connectionStatus = myStatus;
    this.emitState("reconnecting");
    const reconnectStart = performance.now();
    this.logger.debug("LiveKit reconnect started", {
      generation,
      maxAttempts: MAX_ATTEMPTS,
      modelName: this.config.modelName ?? null,
      subscribeMode: this.subscribeMode,
    });

    try {
      let attemptCount = 0;

      await pRetry(
        async () => {
          attemptCount++;
          if (this.connectionStatus !== myStatus) {
            throw new AbortError("Reconnect cancelled");
          }
          myStatus.queued = false;
          this.logger.debug("LiveKit reconnect attempt started", {
            attempt: attemptCount,
            maxAttempts: MAX_ATTEMPTS,
          });

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
          onFailedAttempt: (error) => {
            if (this.connectionStatus !== myStatus) return;
            this.logger.warn("Reconnect attempt failed", {
              error: error.message,
              attempt: error.attemptNumber,
              maxAttempts: MAX_ATTEMPTS,
              retriesLeft: error.retriesLeft,
              elapsedMs: Math.round(performance.now() - reconnectStart),
            });
            this.config.onDiagnostic?.("reconnect", {
              attempt: error.attemptNumber,
              maxAttempts: MAX_ATTEMPTS,
              durationMs: performance.now() - reconnectStart,
              success: false,
              error: error.message,
            });
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
      this.config.onDiagnostic?.("reconnect", {
        attempt: attemptCount,
        maxAttempts: MAX_ATTEMPTS,
        durationMs: performance.now() - reconnectStart,
        success: true,
      });
      this.logger.info("LiveKit reconnect completed", {
        attempts: attemptCount,
        maxAttempts: MAX_ATTEMPTS,
        durationMs: Math.round(performance.now() - reconnectStart),
        generation,
      });
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
    const connectStart = performance.now();
    this.logger.debug("LiveKit initial connect started", {
      url: sanitizeUrl(this.config.url),
      subscribeMode: this.subscribeMode,
      maxAttempts: MAX_ATTEMPTS,
      timeoutMs: CONNECTION_TIMEOUT,
      modelName: this.config.modelName ?? null,
    });

    try {
      const result = await pRetry(
        async () => {
          if (this.connectionStatus !== myStatus) {
            throw new AbortError("Connect cancelled");
          }
          myStatus.queued = false;
          await this.connection.connect(this.config.url, localStream, CONNECTION_TIMEOUT, this.config.integration);
          this.logger.info("LiveKit initial connect succeeded", {
            modelName: this.config.modelName ?? null,
            durationMs: Math.round(performance.now() - connectStart),
          });
          return true;
        },
        {
          ...RETRY_OPTIONS,
          onFailedAttempt: (error) => {
            this.logger.warn("Connection attempt failed", {
              error: error.message,
              attempt: error.attemptNumber,
              maxAttempts: MAX_ATTEMPTS,
              retriesLeft: error.retriesLeft,
              elapsedMs: Math.round(performance.now() - connectStart),
            });
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

  /**
   * Stats source for telemetry. Aggregates LiveKit room track reports.
   */
  getStatsProvider(): StatsProvider | null {
    return this.connection.getStatsProvider();
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
