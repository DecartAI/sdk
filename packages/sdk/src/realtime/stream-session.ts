import mitt, { type Emitter } from "mitt";
import pRetry, { AbortError } from "p-retry";

import { createConsoleLogger, type Logger } from "../utils/logger";
import { REALTIME_CONFIG } from "./config-realtime";
import { InitialStateGate } from "./initial-state-gate";
import { MediaChannel, type VideoCodec } from "./media-channel";
import type { RealtimeObservability } from "./observability/realtime-observability";
import { SignalingChannel } from "./signaling-channel";
import type {
  ConnectionState,
  ConnectionStatus,
  GenerationEnded,
  GenerationTick,
  ImageSetOptions,
  InitialPrompt,
  InitialState,
  PromptSendOptions,
  QueuePosition,
  SessionStarted,
  SetImagePayload,
} from "./types";

type RetryAttemptError = Error & {
  attemptNumber?: number;
  retriesLeft?: number;
};

type ConnectionLossCause = Record<string, unknown>;

export function encodeSubscribeToken(roomName: string): string {
  return btoa(JSON.stringify({ room_name: roomName }));
}

function getInitialImageSizeKb(image: string | null | undefined): number | null {
  if (!image) return null;
  const commaIdx = image.indexOf(",");
  const base64 = commaIdx >= 0 && image.startsWith("data:") ? image.slice(commaIdx + 1) : image;
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  const bytes = Math.floor((base64.length * 3) / 4) - padding;
  return Math.max(0, Math.round(bytes / 1024));
}

type StreamSessionEvents = {
  connectionChange: ConnectionState;
  queuePosition: QueuePosition;
  sessionStarted: SessionStarted;
  generationTick: GenerationTick;
  generationEnded: GenerationEnded;
  remoteStream: MediaStream;
  error: Error;
};

interface StreamSessionConfig {
  url: string;
  integration?: string;
  observability?: RealtimeObservability;
  localStream: MediaStream | null;
  initialImage?: string;
  initialImageRef?: string;
  initialPrompt?: InitialPrompt;
  logger?: Logger;
  videoCodec?: VideoCodec;
}

export class StreamSession {
  private signaling!: SignalingChannel;
  private media!: MediaChannel;
  private events: Emitter<StreamSessionEvents> = mitt();

  private state: ConnectionState = "disconnected";
  private queue: QueuePosition | null = null;

  private disposed = false;
  private currentAttempt = 0;

  private readonly initialStateGate = new InitialStateGate();
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

  getStatus(): Readonly<ConnectionStatus> {
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
    this.logger.info("realtime connect: starting", { attemptCycle: attempt });

    try {
      await pRetry(() => this.runOneConnect(attempt), this.retryOptionsFor(attempt));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error("realtime connect: exhausted all retries", { error: message });
      if (this.currentAttempt === attempt && !this.disposed) {
        this.setState("disconnected");
      }
      throw error;
    }
  }

  async sendPrompt(text: string, opts?: PromptSendOptions): Promise<void> {
    this.assertConnected();
    return this.signaling.sendPrompt(text, opts);
  }

  async setImage(payload: SetImagePayload, opts?: ImageSetOptions): Promise<void> {
    this.assertConnected();
    return this.signaling.setImage(payload, opts);
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
      ...REALTIME_CONFIG.session.retry,
      onFailedAttempt: (_error: RetryAttemptError) => {
        this.tearDown();
      },
      shouldRetry: (error: Error) => {
        if (this.disposed || this.currentAttempt !== attempt) return false;
        const msg = error.message.toLowerCase();
        const permanent = REALTIME_CONFIG.session.permanentErrorSubstrings.some((err) => msg.includes(err));
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

    try {
      this.resetHandshakeState();
      const initialState = this.getInitialState();
      this.config.observability?.beginConnectionBreakdown(attempt, getInitialImageSizeKb(initialState?.image));
      const gateAttempt = this.initialStateGate.startAttempt(initialState);

      const { roomInfo, initialStateAck } = await this.signaling.openAndJoin({
        connectTimeout: REALTIME_CONFIG.session.connectionTimeoutMs,
        initialState,
      });

      if (this.disposed || this.currentAttempt !== attempt) {
        this.tearDown();
        throw new AbortError("Stale connect attempt");
      }

      this.queue = null;

      try {
        await this.media.connect({
          url: roomInfo.livekitUrl,
          token: roomInfo.token,
        });
        const isCurrentAttempt = await gateAttempt.waitForReadiness(initialStateAck);
        if (!isCurrentAttempt) {
          throw new AbortError("Stale connect attempt");
        }
        await this.media.publishLocalTracks();
      } catch (error) {
        this.tearDown();
        throw error;
      }

      if (this.disposed || this.currentAttempt !== attempt) {
        this.tearDown();
        throw new AbortError("Stale connect attempt");
      }

      this.config.observability?.finishConnectionBreakdown({ success: true });

      this.setState("connected");
      this.events.emit("sessionStarted", {
        sessionId: roomInfo.sessionId,
        subscribeToken: encodeSubscribeToken(roomInfo.roomName),
      });
    } catch (error) {
      this.config.observability?.finishConnectionBreakdown({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private getInitialState(): InitialState | undefined {
    if (this.config.initialImageRef !== undefined) {
      return {
        imageRef: this.config.initialImageRef,
        prompt: this.config.initialPrompt?.text,
        enhance: this.config.initialPrompt?.enhance,
      };
    }

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

  private handleConnectionLoss(cause: ConnectionLossCause): void {
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
        this.logger.info("realtime reconnect: succeeded");
      })
      .catch((error) => {
        if (this.disposed || this.currentAttempt !== attempt) return;
        const message = error instanceof Error ? error.message : String(error);
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
      videoCodec: this.config.videoCodec,
    });
    this.wireSignalingEvents();
    this.wireMediaEvents();
  }

  private tearDown(): void {
    this.signaling.close();
    this.media.disconnect();
    this.initialStateGate.reset();
    this.resetHandshakeState();
  }

  private resetHandshakeState(): void {
    this.queue = null;
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.logger.debug("realtime state change", { from: this.state, to: state });
    this.state = state;
    this.events.emit("connectionChange", state);
  }
}
