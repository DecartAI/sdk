import mitt, { type Emitter } from "mitt";
import pRetry, { AbortError } from "p-retry";

import type { ModelDefinition } from "../shared/model";
import { type Logger, createConsoleLogger } from "../utils/logger";
import { MediaChannel } from "./media-channel";
import type { RealtimeObservability } from "./observability/realtime-observability";
import { type RoomInfo, SignalingChannel } from "./signaling-channel";
import type { ConnectionState, InitialState, QueuePosition } from "./types";

const PERMANENT_ERRORS = [
  "permission denied",
  "not allowed",
  "invalid session",
  "401",
  "invalid api key",
  "unauthorized",
];

const CONNECTION_TIMEOUT_MS = 60_000 * 5;

const RETRY_OPTIONS = {
  retries: 5,
  factor: 2,
  minTimeout: 1000,
  maxTimeout: 10000,
} as const;

export function encodeSubscribeToken(roomName: string): string {
  return btoa(JSON.stringify({ room_name: roomName }));
}

type StreamSessionEvents = {
  connectionChange: ConnectionState;
  queuePosition: QueuePosition;
  sessionStarted: { sessionId: string; subscribeToken: string };
  generationTick: { seconds: number };
  generationEnded: { seconds: number; reason: string };
  remoteStream: MediaStream;
  error: Error;
};

interface StreamSessionConfig {
  url: string;
  integration?: string;
  observability?: RealtimeObservability;
  localStream: MediaStream | null;
  model?: Pick<ModelDefinition, "fps">;
  initialImage?: string;
  initialPrompt?: { text: string; enhance?: boolean };
  logger?: Logger;
}

export class StreamSession {
  private signaling!: SignalingChannel;
  private media!: MediaChannel;
  private events: Emitter<StreamSessionEvents> = mitt();

  private state: ConnectionState = "disconnected";
  private queue: QueuePosition | null = null;

  private disposed = false;
  private currentAttempt = 0;

  private roomInfo: RoomInfo | null = null;
  private readonly logger: Logger;

  constructor(private readonly config: StreamSessionConfig) {
    this.logger = config.logger ?? createConsoleLogger("warn");
    this.createTransport();
  }

  on<E extends keyof StreamSessionEvents>(event: E, handler: (data: StreamSessionEvents[E]) => void): void {
    this.events.on(event, handler);
  }

  off<E extends keyof StreamSessionEvents>(event: E, handler: (data: StreamSessionEvents[E]) => void): void {
    this.events.off(event, handler);
  }

  getStatus(): Readonly<{ connection: ConnectionState; queue: QueuePosition | null }> {
    return { connection: this.state, queue: this.queue };
  }

  getConnectionState(): ConnectionState {
    return this.state;
  }

  isConnected(): boolean {
    return this.state === "connected" || this.state === "generating";
  }

  async connect(): Promise<void> {
    this.disposed = false;
    const attempt = ++this.currentAttempt;
    this.setState("connecting");
    const startedAt = Date.now();
    this.logger.info("realtime connect: starting", { attemptCycle: attempt });

    try {
      await pRetry(() => this.runOneConnect(attempt), this.retryOptionsFor(attempt));
      this.config.observability?.diagnostic("phaseTiming", {
        phase: "total",
        durationMs: Date.now() - startedAt,
        success: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.config.observability?.diagnostic("phaseTiming", {
        phase: "total",
        durationMs: Date.now() - startedAt,
        success: false,
        error: message,
      });
      this.logger.error("realtime connect: exhausted all retries", { error: message });
      if (this.currentAttempt === attempt && !this.disposed) {
        this.setState("disconnected");
      }
      throw error;
    }
  }

  async sendPrompt(text: string, opts?: { enhance?: boolean; timeout?: number }): Promise<void> {
    this.assertConnected();
    return this.signaling.sendPrompt(text, opts);
  }

  async setImage(
    image: string | null,
    opts?: { prompt?: string | null; enhance?: boolean; timeout?: number },
  ): Promise<void> {
    this.assertConnected();
    return this.signaling.setImage(image, opts);
  }

  disconnect(): void {
    this.disposed = true;
    this.tearDown();
    this.setState("disconnected");
  }

  private assertConnected(): void {
    if (!this.isConnected()) {
      throw new Error(`Cannot send message: connection is ${this.state}`);
    }
  }

  private retryOptionsFor(attempt: number) {
    return {
      ...RETRY_OPTIONS,
      onFailedAttempt: (error: Error & { attemptNumber?: number; retriesLeft?: number }) => {
        const attemptNumber = error.attemptNumber ?? 0;
        const retriesLeft = error.retriesLeft ?? 0;
        this.logger.warn("realtime connect: attempt failed", {
          attemptNumber,
          retriesLeft,
          error: error.message,
          state: this.state,
        });
        this.config.observability?.diagnostic("reconnect", {
          attempt: attemptNumber,
          maxAttempts: attemptNumber + retriesLeft,
          durationMs: 0,
          success: false,
          error: error.message,
        });
        this.tearDown();
      },
      shouldRetry: (error: Error) => {
        if (this.disposed || this.currentAttempt !== attempt) return false;
        const msg = error.message.toLowerCase();
        const permanent = PERMANENT_ERRORS.some((err) => msg.includes(err));
        if (permanent) {
          this.logger.error("realtime connect: permanent error, not retrying", { error: error.message });
        }
        return !permanent;
      },
    };
  }

  private async runOneConnect(attempt: number): Promise<void> {
    if (this.disposed || this.currentAttempt !== attempt) {
      throw new AbortError("Stale connect attempt");
    }

    this.resetHandshakeState();
    await this.signaling.connect({
      connectTimeout: CONNECTION_TIMEOUT_MS,
      initialState: this.getInitialState(),
    });

    if (!this.roomInfo) {
      throw new Error("Handshake completed without room info");
    }
    if (this.disposed || this.currentAttempt !== attempt) {
      this.tearDown();
      throw new AbortError("Stale connect attempt");
    }

    await this.media.connect({
      url: this.roomInfo.livekitUrl,
      token: this.roomInfo.token,
    });

    if (this.disposed || this.currentAttempt !== attempt) {
      this.tearDown();
      throw new AbortError("Stale connect attempt");
    }

    this.setState("connected");
  }

  private getInitialState(): InitialState | undefined {
    if (this.config.initialImage !== undefined) {
      return {
        image: this.config.initialImage,
        prompt: this.config.initialPrompt?.text,
        enhance: this.config.initialPrompt?.enhance,
      };
    }

    if (this.config.initialPrompt) {
      return {
        prompt: this.config.initialPrompt.text,
        enhance: this.config.initialPrompt.enhance,
      };
    }

    if (this.config.localStream) {
      return { image: null, prompt: null };
    }

    return undefined;
  }

  private wireSignalingEvents(): void {
    this.signaling.on("roomInfo", (info) => {
      this.roomInfo = info;
      this.queue = null;
      this.media.prepare(info.livekitUrl, info.token);
      this.events.emit("sessionStarted", {
        sessionId: info.sessionId,
        subscribeToken: encodeSubscribeToken(info.roomName),
      });
    });
    this.signaling.on("queuePosition", (qp) => {
      this.queue = qp;
      this.events.emit("queuePosition", qp);
    });
    this.signaling.on("generationTick", (e) => this.events.emit("generationTick", e));
    this.signaling.on("generationEnded", (e) => this.events.emit("generationEnded", e));
    this.signaling.on("serverError", (err) => this.events.emit("error", err));
    this.signaling.on("closed", (info) => this.handleConnectionLoss({ source: "signaling", ...info }));
  }

  private wireMediaEvents(): void {
    this.media.on("remoteStream", (stream) => this.events.emit("remoteStream", stream));
    this.media.on("firstFrame", () => {
      if (this.state === "connected") this.setState("generating");
    });
    this.media.on("disconnected", (info) => this.handleConnectionLoss({ source: "media", reason: info.reason }));
  }

  private handleConnectionLoss(cause: Record<string, unknown>): void {
    if (this.disposed) return;
    if (this.state !== "connected" && this.state !== "generating") {
      this.logger.debug("connection loss ignored (not connected)", { state: this.state, ...cause });
      return;
    }
    this.logger.warn("realtime connection lost; scheduling reconnect", { state: this.state, ...cause });
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    const attempt = ++this.currentAttempt;
    const startedAt = Date.now();
    this.setState("reconnecting");

    pRetry(async () => {
      if (this.disposed || this.currentAttempt !== attempt) {
        throw new AbortError("Reconnect cancelled");
      }
      this.tearDown();
      this.createTransport();
      await this.runOneConnect(attempt);
    }, this.retryOptionsFor(attempt))
      .then(() => {
        if (this.disposed || this.currentAttempt !== attempt) return;
        this.config.observability?.diagnostic("reconnect", {
          attempt: 1,
          maxAttempts: RETRY_OPTIONS.retries + 1,
          durationMs: Date.now() - startedAt,
          success: true,
        });
        this.logger.info("realtime reconnect: succeeded", { durationMs: Date.now() - startedAt });
      })
      .catch((error) => {
        if (this.disposed || this.currentAttempt !== attempt) return;
        const message = error instanceof Error ? error.message : String(error);
        this.config.observability?.diagnostic("reconnect", {
          attempt: RETRY_OPTIONS.retries + 1,
          maxAttempts: RETRY_OPTIONS.retries + 1,
          durationMs: Date.now() - startedAt,
          success: false,
          error: message,
        });
        this.logger.error("realtime reconnect: failed permanently", { error: message });
        this.tearDown();
        this.setState("disconnected");
        this.events.emit("error", error instanceof Error ? error : new Error(String(error)));
      });
  }

  private createTransport(): void {
    this.signaling = new SignalingChannel({
      url: this.config.url,
      integration: this.config.integration,
      logger: this.logger,
      observability: this.config.observability,
    });
    this.media = new MediaChannel({
      observability: this.config.observability,
      localStream: this.config.localStream,
      logger: this.logger,
    });
    this.wireSignalingEvents();
    this.wireMediaEvents();
  }

  private tearDown(): void {
    this.signaling.close();
    this.media.disconnect();
    this.resetHandshakeState();
  }

  private resetHandshakeState(): void {
    this.roomInfo = null;
    this.queue = null;
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.logger.debug("realtime state change", { from: this.state, to: state });
    this.state = state;
    this.events.emit("connectionChange", state);
  }
}
