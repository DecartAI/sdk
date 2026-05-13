import mitt, { type Emitter } from "mitt";
import pRetry, { AbortError } from "p-retry";

import type { ModelDefinition } from "../shared/model";
import { SignalingChannel, type RoomInfo } from "./signaling-channel";
import { MediaChannel } from "./media-channel";
import type { RealtimeObservability } from "./observability/realtime-observability";
import type { ConnectionState, QueuePosition } from "./types";

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

  constructor(private readonly config: StreamSessionConfig) {
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

    try {
      await pRetry(() => this.runOneConnect(attempt), this.retryOptionsFor(attempt));
    } catch (error) {
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
      onFailedAttempt: () => this.tearDown(),
      shouldRetry: (error: Error) => {
        if (this.disposed || this.currentAttempt !== attempt) return false;
        const msg = error.message.toLowerCase();
        return !PERMANENT_ERRORS.some((err) => msg.includes(err));
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
      initialState: {
        image: this.config.initialImage,
        prompt: this.config.initialPrompt?.text,
        enhance: this.config.initialPrompt?.enhance,
      },
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
    this.signaling.on("closed", () => this.handleConnectionLoss());
  }

  private wireMediaEvents(): void {
    this.media.on("remoteStream", (stream) => this.events.emit("remoteStream", stream));
    this.media.on("firstFrame", () => {
      if (this.state === "connected") this.setState("generating");
    });
    this.media.on("disconnected", () => this.handleConnectionLoss());
  }

  private handleConnectionLoss(): void {
    if (this.disposed) return;
    if (this.state !== "connected" && this.state !== "generating") return;
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
    }, this.retryOptionsFor(attempt)).catch((error) => {
      if (this.disposed || this.currentAttempt !== attempt) return;
      this.tearDown();
      this.setState("disconnected");
      this.events.emit("error", error instanceof Error ? error : new Error(String(error)));
    });
  }

  private createTransport(): void {
    this.signaling = new SignalingChannel({ url: this.config.url, integration: this.config.integration });
    this.media = new MediaChannel({
      observability: this.config.observability,
      localStream: this.config.localStream,
      model: this.config.model,
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
    this.state = state;
    this.events.emit("connectionChange", state);
  }
}
