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
  LiveKitJoinMessage,
  OutgoingRealtimeMessage,
  PromptAckMessage,
  PromptMessage,
  PromptSendOptions,
  QueuePosition,
  ServerError,
  SetImageAckMessage,
  SetImageMessage,
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
  generationStarted: undefined;
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
  passthrough?: boolean;
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
  write?: boolean;
};

type InitialStateRequest = {
  message: SetImageMessage | PromptMessage;
  matchAck: (msg: IncomingRealtimeMessage) => boolean;
  label: string;
};

function buildInitialStateRequest(initialState?: InitialState): InitialStateRequest | null {
  if (!initialState) return null;

  if (initialState.imageRef !== undefined || initialState.image !== undefined) {
    const message: SetImageMessage =
      initialState.imageRef !== undefined
        ? { type: "set_image", image_ref: initialState.imageRef }
        : { type: "set_image", image_data: initialState.image ?? null };
    if (initialState.prompt !== undefined) message.prompt = initialState.prompt;
    if (initialState.enhance !== undefined) message.enhance_prompt = initialState.enhance;
    return { message, matchAck: (msg) => msg.type === "set_image_ack", label: "Image send" };
  }

  if (initialState.prompt !== undefined && initialState.prompt !== null) {
    const text = initialState.prompt;
    return {
      message: { type: "prompt", prompt: text, enhance_prompt: initialState.enhance ?? true },
      matchAck: (msg) => msg.type === "prompt_ack" && msg.prompt === text,
      label: "Prompt send",
    };
  }

  return null;
}

export class SignalingChannel {
  private ws: WebSocket | null = null;
  private events: Emitter<SignalingChannelEvents> = mitt();
  private pendingAcks: PendingAck[] = [];
  private bufferedAcks: IncomingRealtimeMessage[] = [];
  private pendingRoomInfo: PendingRoomInfo | null = null;
  private earlyFatalError: Error | null = null;
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
    const openAndJoinSpan = this.config.observability?.startSpan("SignalingChannel.openAndJoin");
    const connectTimeout = opts.connectTimeout ?? REALTIME_CONFIG.signaling.connectTimeoutMs;
    const handshakeTimeout = opts.handshakeTimeout ?? REALTIME_CONFIG.signaling.handshakeTimeoutMs;

    try {
      this.config.observability?.startPhase("websocket-open");
      await this.openSocket(connectTimeout);
      this.throwEarlyFatalError();
      this.config.observability?.endPhase("websocket-open", { success: true });

      this.config.observability?.startPhase("room-join");
      const roomInfoWait = this.waitForRoomInfo(handshakeTimeout);

      // Lean join first, then the initial state as its own frame. The server
      // returns room_info off the small join frame without waiting for the
      // (multi-MB) image to upload, so the upload overlaps the SFU connect rather
      // than blocking room_info. Order matters: the join must be written first.
      const buildInitialStateSpan = this.config.observability?.startSpan("buildInitialStateRequest");
      const initialStateRequest = buildInitialStateRequest(opts.initialState);
      this.config.observability?.endSpan(buildInitialStateSpan);
      const userSetInitialState =
        opts.initialState != null &&
        (opts.initialState.image != null || opts.initialState.imageRef != null || opts.initialState.prompt != null);
      const joinMessage: LiveKitJoinMessage = {
        type: "livekit_join",
        passthrough: opts.passthrough ?? !userSetInitialState,
      };

      if (!this.writeMessage(joinMessage, "livekit_join")) {
        roomInfoWait.cancel();
        throw new Error("WebSocket is not open");
      }

      if (initialStateRequest && !this.writeMessage(initialStateRequest.message, initialStateRequest.message.type)) {
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

      // Arm the ack only now that room info arrived, so a long queue wait cannot
      // trip the ack timeout. The message was already written as its own frame
      // right after the join, so this waits for the ack without writing again.
      const initialStateAck = initialStateRequest ? this.flushInitialState(initialStateRequest) : Promise.resolve();
      initialStateAck.catch(() => {});

      this.config.observability?.endSpan(openAndJoinSpan);
      return { roomInfo, initialStateAck };
    } catch (error) {
      this.config.observability?.endSpan(openAndJoinSpan, {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async flushInitialState(request: InitialStateRequest): Promise<void> {
    const span = this.config.observability?.startSpan("SignalingChannel.flushInitialState", request.label);
    this.config.observability?.startPhase("initial-state-handshake");
    try {
      const ack = await this.request<SetImageAckMessage | PromptAckMessage>({
        message: request.message,
        matchAck: request.matchAck,
        timeoutMs: REALTIME_CONFIG.signaling.requestTimeoutMs,
        label: request.label,
        write: false,
      });
      this.config.observability?.endPhase("initial-state-handshake", { success: true });
      if (!ack.success) throw new Error(ack.error ?? `Failed: ${request.label}`);
      this.config.observability?.endSpan(span);
    } catch (error) {
      this.config.observability?.endPhase("initial-state-handshake", {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
      this.config.observability?.endSpan(span, {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
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
    const span = this.config.observability?.startSpan("SignalingChannel.openSocket");
    const userAgent = encodeURIComponent(buildUserAgent(this.config.integration));
    const separator = this.config.url.includes("?") ? "&" : "?";
    // Tell the bouncer at WS-open that this is a livekit join so it returns room_info
    // immediately instead of waiting ~1 RTT for the join frame written below.
    const wsUrl = `${this.config.url}${separator}user_agent=${userAgent}&livekit_join=1`;
    this.closing = false;
    this.earlyFatalError = null;

    try {
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
          if (!wasConnected && !this.closing) {
            this.earlyFatalError = error;
          }
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
      this.config.observability?.endSpan(span);
    } catch (error) {
      this.config.observability?.endSpan(span, {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private waitForRoomInfo(timeoutMs: number): RoomInfoWait {
    const span = this.config.observability?.startSpan("SignalingChannel.waitForRoomInfo");
    let cleanup: () => void = () => {};
    const promise = new Promise<RoomInfo>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
        cleanup();
        this.logger.warn("signaling: livekit_room_info timeout", { timeoutMs });
        const error = new Error(`livekit_room_info timeout (${timeoutMs}ms)`);
        this.config.observability?.endSpan(span, { success: false, error: error.message });
        reject(error);
      }, timeoutMs);

      const pendingRoomInfo: PendingRoomInfo = {
        resolve: (info) => {
          cleanup();
          this.config.observability?.endSpan(span);
          resolve(info);
        },
        reject: (err) => {
          cleanup();
          this.config.observability?.endSpan(span, { success: false, error: err.message });
          reject(err);
        },
        cancel: () => {
          cleanup();
          this.config.observability?.endSpan(span, { success: false, error: "cancelled" });
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

  private async request<TAck extends IncomingRealtimeMessage>({
    message,
    matchAck,
    timeoutMs,
    label,
    write = true,
  }: RequestOptions): Promise<TAck> {
    const span = this.config.observability?.startSpan("SignalingChannel.request", label);
    return new Promise<TAck>((resolve, reject) => {
      const buffered = this.bufferedAcks.findIndex((m) => matchAck(m));
      if (buffered !== -1) {
        const [claimed] = this.bufferedAcks.splice(buffered, 1);
        this.config.observability?.endSpan(span);
        resolve(claimed as TAck);
        return;
      }

      const timer = setTimeout(() => {
        cleanup();
        this.logger.warn("signaling: ack timed out", { label, timeoutMs });
        const error = new Error(`${label} timed out`);
        this.config.observability?.endSpan(span, { success: false, error: error.message });
        reject(error);
      }, timeoutMs);

      const entry: PendingAck = {
        matches: matchAck,
        onMatch: (msg) => {
          cleanup();
          this.config.observability?.endSpan(span);
          resolve(msg as TAck);
        },
        reject: (err) => {
          cleanup();
          this.config.observability?.endSpan(span, { success: false, error: err.message });
          reject(err);
        },
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.pendingAcks = this.pendingAcks.filter((e) => e !== entry);
      };
      this.pendingAcks.push(entry);

      if (write && !this.writeMessage(message)) {
        cleanup();
        const error = new Error("WebSocket is not open");
        this.config.observability?.endSpan(span, { success: false, error: error.message });
        reject(error);
      }
    });
  }

  private writeMessage(message: OutgoingRealtimeMessage, detail: string = message.type): boolean {
    const span = this.config.observability?.startSpan("SignalingChannel.writeMessage", detail);
    if (this.ws?.readyState !== WebSocket.OPEN) {
      this.config.observability?.endSpan(span, { success: false, error: "WebSocket is not open" });
      return false;
    }
    this.ws.send(JSON.stringify(message));
    this.config.observability?.endSpan(span);
    return true;
  }

  private handleMessage(msg: IncomingRealtimeMessage): void {
    const span = this.config.observability?.startSpan("SignalingChannel.handleMessage", msg.type);
    try {
      for (const ack of [...this.pendingAcks]) {
        if (ack.matches(msg)) {
          ack.onMatch(msg);
          return;
        }
      }

      if (!this.connected && (msg.type === "set_image_ack" || msg.type === "prompt_ack")) {
        this.bufferedAcks.push(msg);
        return;
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
        case "generation_started":
          this.events.emit("generationStarted");
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
          if (!this.connected) {
            this.earlyFatalError = error;
          }
          this.logger.error("signaling: server error received", { error: msg.error });
          this.events.emit("serverError", error);
          this.rejectPendingRoomInfo(error);
          this.rejectAllPending(error);
          break;
        }
      }
    } finally {
      this.config.observability?.endSpan(span);
    }
  }

  private resolvePendingRoomInfo(info: RoomInfo): void {
    const pending = this.pendingRoomInfo;
    if (!pending) return;
    pending.resolve(info);
  }

  private throwEarlyFatalError(): void {
    if (!this.earlyFatalError) return;
    throw this.earlyFatalError;
  }

  private rejectPendingRoomInfo(error: Error): void {
    const pending = this.pendingRoomInfo;
    if (!pending) return;
    pending.reject(error);
  }

  private rejectAllPending(error: Error): void {
    const pending = this.pendingAcks;
    this.pendingAcks = [];
    this.bufferedAcks = [];
    for (const entry of pending) entry.reject(error);
  }
}
