import mitt, { type Emitter } from "mitt";

import { createConsoleLogger, type Logger } from "../utils/logger";
import { buildUserAgent } from "../utils/user-agent";
import { REALTIME_CONFIG } from "./config-realtime";
import type { RealtimeObservability } from "./observability/realtime-observability";
import type {
  ConnectionClosed,
  GenerationEnded,
  GenerationTick,
  ImageSetOptions,
  IncomingRealtimeMessage,
  InitialState,
  OutgoingRealtimeMessage,
  PromptAckMessage,
  PromptSendOptions,
  QueuePosition,
  ServerError,
  SetImageAckMessage,
  SetImagePayload,
} from "./types";

export type RoomInfo = {
  livekitUrl: string;
  token: string;
  roomName: string;
  sessionId: string;
};

export type SignalingChannelEvents = {
  queuePosition: QueuePosition;
  generationTick: GenerationTick;
  generationEnded: GenerationEnded;
  serverError: Error;
  closed: ConnectionClosed;
};

export interface SignalingChannelConfig {
  url: string;
  integration?: string;
  logger?: Logger;
  observability?: RealtimeObservability;
}

type PendingAck = {
  matches: (msg: IncomingRealtimeMessage) => boolean;
  onMatch: (msg: IncomingRealtimeMessage) => void;
  reject: (err: Error) => void;
};

type PendingRoomInfo = {
  resolve: (info: RoomInfo) => void;
  reject: (err: Error) => void;
  cancel: () => void;
  pauseTimeout: () => void;
};

export type OpenAndJoinOptions = {
  connectTimeout?: number;
  handshakeTimeout?: number;
  initialState?: InitialState;
};

export type OpenAndJoinResult = {
  roomInfo: RoomInfo;
  initialStateAck: Promise<void>;
};

type RoomInfoWait = {
  promise: Promise<RoomInfo>;
  cancel: () => void;
};

type RequestOptions = {
  message: OutgoingRealtimeMessage;
  matchAck: (msg: IncomingRealtimeMessage) => boolean;
  timeoutMs: number;
  label: string;
};

export class SignalingChannel {
  private ws: WebSocket | null = null;
  private events: Emitter<SignalingChannelEvents> = mitt();
  private pendingAcks: PendingAck[] = [];
  private pendingRoomInfo: PendingRoomInfo | null = null;
  private connected = false;
  private closing = false;
  private readonly logger: Logger;

  constructor(private readonly config: SignalingChannelConfig) {
    this.logger = config.logger ?? createConsoleLogger("warn");
  }

  on<E extends keyof SignalingChannelEvents>(event: E, handler: (data: SignalingChannelEvents[E]) => void): void {
    this.events.on(event, handler);
  }

  off<E extends keyof SignalingChannelEvents>(event: E, handler: (data: SignalingChannelEvents[E]) => void): void {
    this.events.off(event, handler);
  }

  async openAndJoin(opts: OpenAndJoinOptions = {}): Promise<OpenAndJoinResult> {
    const connectTimeout = opts.connectTimeout ?? REALTIME_CONFIG.signaling.connectTimeoutMs;
    const handshakeTimeout = opts.handshakeTimeout ?? REALTIME_CONFIG.signaling.handshakeTimeoutMs;

    this.config.observability?.startPhase("websocket-open");
    await this.openSocket(connectTimeout);
    this.config.observability?.endPhase("websocket-open", { success: true });

    this.config.observability?.startPhase("room-join");
    const roomInfoWait = this.waitForRoomInfo(handshakeTimeout);

    if (!this.writeMessage({ type: "livekit_join" })) {
      roomInfoWait.cancel();
      throw new Error("WebSocket is not open");
    }

    let roomInfo: RoomInfo;
    try {
      roomInfo = await roomInfoWait.promise;
    } catch (error) {
      this.rejectAllPending(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
    this.config.observability?.endPhase("room-join", { success: true });

    this.connected = true;

    const initialStateAck = this.sendInitialStateTracked(opts.initialState);
    initialStateAck.catch(() => {});

    return { roomInfo, initialStateAck };
  }

  private async sendInitialStateTracked(initialState?: InitialState): Promise<void> {
    if (!initialState) return;
    this.config.observability?.startPhase("initial-state-handshake");
    await this.sendInitialState(initialState);
    this.config.observability?.endPhase("initial-state-handshake", { success: true });
  }

  close(): void {
    this.closing = true;
    this.connected = false;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
    this.rejectPendingRoomInfo(new Error("Control channel closed"));
    this.rejectAllPending(new Error("Control channel closed"));
  }

  async sendPrompt(text: string, opts: PromptSendOptions = {}): Promise<void> {
    const ack = await this.request<PromptAckMessage>({
      message: { type: "prompt", prompt: text, enhance_prompt: opts.enhance ?? true },
      matchAck: (msg) => msg.type === "prompt_ack" && msg.prompt === text,
      timeoutMs: opts.timeout ?? REALTIME_CONFIG.signaling.requestTimeoutMs,
      label: "Prompt send",
    });
    if (!ack.success) throw new Error(ack.error ?? "Failed to send prompt");
  }

  async setImage(payload: SetImagePayload, opts: ImageSetOptions = {}): Promise<void> {
    const message: OutgoingRealtimeMessage =
      payload.kind === "ref"
        ? { type: "set_image", image_ref: payload.ref }
        : { type: "set_image", image_data: payload.data };
    if (opts.prompt !== undefined) message.prompt = opts.prompt;
    if (opts.enhance !== undefined) message.enhance_prompt = opts.enhance;

    const ack = await this.request<SetImageAckMessage>({
      message,
      matchAck: (msg) => msg.type === "set_image_ack",
      timeoutMs: opts.timeout ?? REALTIME_CONFIG.signaling.requestTimeoutMs,
      label: "Image send",
    });
    if (!ack.success) throw new Error(ack.error ?? "Failed to send image");
  }

  private async openSocket(timeout: number): Promise<void> {
    const userAgent = encodeURIComponent(buildUserAgent(this.config.integration));
    const separator = this.config.url.includes("?") ? "&" : "?";
    const wsUrl = `${this.config.url}${separator}user_agent=${userAgent}`;
    this.closing = false;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`WebSocket open timeout (${timeout}ms)`)), timeout);
      const ws = new WebSocket(wsUrl);
      this.ws = ws;
      ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      ws.onclose = (e) => {
        clearTimeout(timer);
        const wasConnected = this.connected;
        const pendingCount = this.pendingAcks.length;
        this.connected = false;
        this.ws = null;
        this.logger.warn("signaling: websocket closed", {
          code: e.code,
          reason: e.reason,
          wasConnected,
          closing: this.closing,
          pendingAcks: pendingCount,
        });
        const error = new Error(`WebSocket closed: ${e.code} ${e.reason}`);
        this.rejectPendingRoomInfo(error);
        this.rejectAllPending(error);
        if (wasConnected || this.closing) {
          this.events.emit("closed", { code: e.code, reason: e.reason });
        } else {
          reject(error);
        }
      };
      ws.onerror = () => {
        // onclose fires after onerror with details; let it handle the rejection.
      };
      ws.onmessage = (e) => {
        try {
          this.handleMessage(JSON.parse(e.data) as IncomingRealtimeMessage);
        } catch {
          // ignore malformed
        }
      };
    });
  }

  private waitForRoomInfo(timeoutMs: number): RoomInfoWait {
    let cleanup: () => void = () => {};
    const promise = new Promise<RoomInfo>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
        cleanup();
        this.logger.warn("signaling: livekit_room_info timeout", { timeoutMs });
        reject(new Error(`livekit_room_info timeout (${timeoutMs}ms)`));
      }, timeoutMs);

      const pendingRoomInfo: PendingRoomInfo = {
        resolve: (info) => {
          cleanup();
          resolve(info);
        },
        reject: (err) => {
          cleanup();
          reject(err);
        },
        cancel: () => {
          cleanup();
        },
        pauseTimeout: () => {
          if (timer) {
            clearTimeout(timer);
            timer = null;
          }
        },
      };

      cleanup = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        if (this.pendingRoomInfo === pendingRoomInfo) {
          this.pendingRoomInfo = null;
        }
      };

      this.pendingRoomInfo = pendingRoomInfo;
    });

    return { promise, cancel: cleanup };
  }

  private async sendInitialState(initialState?: InitialState): Promise<void> {
    if (!initialState) return;

    if (initialState.imageRef !== undefined) {
      await this.setImage(
        { kind: "ref", ref: initialState.imageRef },
        { prompt: initialState.prompt, enhance: initialState.enhance },
      );
      return;
    }

    if (initialState.image !== undefined) {
      await this.setImage(
        { kind: "data", data: initialState.image },
        { prompt: initialState.prompt, enhance: initialState.enhance },
      );
      return;
    }

    if (initialState.prompt !== undefined && initialState.prompt !== null) {
      await this.sendPrompt(initialState.prompt, { enhance: initialState.enhance });
    }
  }

  private async request<TAck extends IncomingRealtimeMessage>({
    message,
    matchAck,
    timeoutMs,
    label,
  }: RequestOptions): Promise<TAck> {
    return new Promise<TAck>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        this.logger.warn("signaling: ack timed out", { label, timeoutMs });
        reject(new Error(`${label} timed out`));
      }, timeoutMs);

      const entry: PendingAck = {
        matches: matchAck,
        onMatch: (msg) => {
          cleanup();
          resolve(msg as TAck);
        },
        reject: (err) => {
          cleanup();
          reject(err);
        },
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.pendingAcks = this.pendingAcks.filter((e) => e !== entry);
      };
      this.pendingAcks.push(entry);

      if (!this.writeMessage(message)) {
        cleanup();
        reject(new Error("WebSocket is not open"));
      }
    });
  }

  private writeMessage(message: OutgoingRealtimeMessage): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(message));
    return true;
  }

  private handleMessage(msg: IncomingRealtimeMessage): void {
    for (const ack of [...this.pendingAcks]) {
      if (ack.matches(msg)) {
        ack.onMatch(msg);
        break;
      }
    }

    switch (msg.type) {
      case "livekit_room_info":
        this.resolvePendingRoomInfo({
          livekitUrl: msg.livekit_url,
          token: msg.token,
          roomName: msg.room_name,
          sessionId: msg.session_id,
        });
        break;
      case "queue_position":
        this.pendingRoomInfo?.pauseTimeout();
        this.events.emit("queuePosition", {
          position: msg.position,
          queueSize: msg.queue_size,
        });
        break;
      case "generation_tick":
        this.events.emit("generationTick", { seconds: msg.seconds });
        break;
      case "generation_ended":
        this.events.emit("generationEnded", { seconds: msg.seconds, reason: msg.reason });
        break;
      case "error": {
        const error = new Error(msg.error) as ServerError;
        error.source = "server";
        this.logger.error("signaling: server error received", { error: msg.error });
        this.events.emit("serverError", error);
        this.rejectPendingRoomInfo(error);
        this.rejectAllPending(error);
        break;
      }
    }
  }

  private resolvePendingRoomInfo(info: RoomInfo): void {
    const pending = this.pendingRoomInfo;
    if (!pending) return;
    pending.resolve(info);
  }

  private rejectPendingRoomInfo(error: Error): void {
    const pending = this.pendingRoomInfo;
    if (!pending) return;
    pending.reject(error);
  }

  private rejectAllPending(error: Error): void {
    const pending = this.pendingAcks;
    this.pendingAcks = [];
    for (const entry of pending) entry.reject(error);
  }
}
