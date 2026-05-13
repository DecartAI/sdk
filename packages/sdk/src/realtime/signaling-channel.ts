import mitt, { type Emitter } from "mitt";

import { buildUserAgent } from "../utils/user-agent";
import type {
  IncomingRealtimeMessage,
  InitialState,
  OutgoingRealtimeMessage,
  PromptAckMessage,
  QueuePosition,
  SetImageAckMessage,
} from "./types";

const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export type RoomInfo = {
  livekitUrl: string;
  token: string;
  roomName: string;
  sessionId: string;
};

export type SignalingChannelEvents = {
  roomInfo: RoomInfo;
  queuePosition: QueuePosition;
  generationTick: { seconds: number };
  generationEnded: { seconds: number; reason: string };
  serverError: Error;
  closed: { code: number; reason: string };
};

export interface SignalingChannelConfig {
  url: string;
  integration?: string;
}

type PendingAck = {
  matches: (msg: IncomingRealtimeMessage) => boolean;
  onMatch: (msg: IncomingRealtimeMessage) => void;
  reject: (err: Error) => void;
};

export class SignalingChannel {
  private ws: WebSocket | null = null;
  private events: Emitter<SignalingChannelEvents> = mitt();
  private pendingAcks: PendingAck[] = [];
  private connected = false;
  private closing = false;

  constructor(private readonly config: SignalingChannelConfig) {}

  on<E extends keyof SignalingChannelEvents>(event: E, handler: (data: SignalingChannelEvents[E]) => void): void {
    this.events.on(event, handler);
  }

  off<E extends keyof SignalingChannelEvents>(event: E, handler: (data: SignalingChannelEvents[E]) => void): void {
    this.events.off(event, handler);
  }

  async connect(
    opts: { connectTimeout?: number; handshakeTimeout?: number; initialState?: InitialState } = {},
  ): Promise<void> {
    const connectTimeout = opts.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT_MS;
    const handshakeTimeout = opts.handshakeTimeout ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;

    await this.openSocket(connectTimeout);
    await this.runHandshake(handshakeTimeout, opts.initialState);
    this.connected = true;
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
    this.rejectAllPending(new Error("Control channel closed"));
  }

  async sendPrompt(text: string, opts: { enhance?: boolean; timeout?: number } = {}): Promise<void> {
    const ack = await this.request<PromptAckMessage>(
      { type: "prompt", prompt: text, enhance_prompt: opts.enhance ?? true },
      (msg) => msg.type === "prompt_ack" && msg.prompt === text,
      opts.timeout ?? DEFAULT_REQUEST_TIMEOUT_MS,
      "Prompt send",
    );
    if (!ack.success) throw new Error(ack.error ?? "Failed to send prompt");
  }

  async setImage(
    image: string | null,
    opts: { prompt?: string | null; enhance?: boolean; timeout?: number } = {},
  ): Promise<void> {
    const message: OutgoingRealtimeMessage = { type: "set_image", image_data: image };
    if (opts.prompt !== undefined) message.prompt = opts.prompt;
    if (opts.enhance !== undefined) message.enhance_prompt = opts.enhance;

    const ack = await this.request<SetImageAckMessage>(
      message,
      (msg) => msg.type === "set_image_ack",
      opts.timeout ?? DEFAULT_REQUEST_TIMEOUT_MS,
      "Image send",
    );
    if (!ack.success) throw new Error(ack.error ?? "Failed to send image");
  }

  private async openSocket(timeout: number): Promise<void> {
    const userAgent = encodeURIComponent(buildUserAgent(this.config.integration));
    const separator = this.config.url.includes("?") ? "&" : "?";
    const wsUrl = `${this.config.url}${separator}user_agent=${userAgent}`;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("WebSocket timeout")), timeout);
      const ws = new WebSocket(wsUrl);
      this.ws = ws;
      ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      ws.onclose = (e) => {
        clearTimeout(timer);
        const wasConnected = this.connected;
        this.connected = false;
        this.ws = null;
        this.rejectAllPending(new Error(`WebSocket closed: ${e.code} ${e.reason}`));
        if (wasConnected || this.closing) {
          this.events.emit("closed", { code: e.code, reason: e.reason });
        } else {
          reject(new Error(`WebSocket closed: ${e.code} ${e.reason}`));
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

  private async runHandshake(timeoutMs: number, initialState?: InitialState): Promise<void> {
    const roomInfoWait = this.waitForRoomInfo(timeoutMs);

    try {
      if (!this.writeMessage({ type: "livekit_join" })) {
        throw new Error("WebSocket is not open");
      }

      await Promise.all([roomInfoWait.promise, this.sendInitialState(initialState)]);
    } catch (error) {
      roomInfoWait.cancel();
      this.rejectAllPending(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  private waitForRoomInfo(timeoutMs: number): { promise: Promise<void>; cancel: () => void } {
    let cleanup: () => void = () => {};
    const promise = new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
        cleanup();
        reject(new Error(`livekit_room_info timeout (${timeoutMs}ms)`));
      }, timeoutMs);

      const onRoomInfo = () => {
        cleanup();
        resolve();
      };
      const onQueue = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      };
      const onServerError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const onClosed = (e: { code: number; reason: string }) => {
        cleanup();
        reject(new Error(`WebSocket closed: ${e.code} ${e.reason}`));
      };
      cleanup = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        this.events.off("roomInfo", onRoomInfo);
        this.events.off("queuePosition", onQueue);
        this.events.off("serverError", onServerError);
        this.events.off("closed", onClosed);
      };

      this.events.on("roomInfo", onRoomInfo);
      this.events.on("queuePosition", onQueue);
      this.events.on("serverError", onServerError);
      this.events.on("closed", onClosed);
    });

    return { promise, cancel: cleanup };
  }

  private async sendInitialState(initialState?: InitialState): Promise<void> {
    if (!initialState) return;

    if (initialState.image !== undefined) {
      await this.setImage(initialState.image, {
        prompt: initialState.prompt,
        enhance: initialState.enhance,
      });
      return;
    }

    if (initialState.prompt !== undefined && initialState.prompt !== null) {
      await this.sendPrompt(initialState.prompt, { enhance: initialState.enhance });
    }
  }

  private async request<TAck extends IncomingRealtimeMessage>(
    message: OutgoingRealtimeMessage,
    matchAck: (msg: IncomingRealtimeMessage) => boolean,
    timeoutMs: number,
    label: string,
  ): Promise<TAck> {
    return new Promise<TAck>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
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
        this.events.emit("roomInfo", {
          livekitUrl: msg.livekit_url,
          token: msg.token,
          roomName: msg.room_name,
          sessionId: msg.session_id,
        });
        break;
      case "queue_position":
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
        const error = new Error(msg.error) as Error & { source?: string };
        error.source = "server";
        this.events.emit("serverError", error);
        this.rejectAllPending(error);
        break;
      }
    }
  }

  private rejectAllPending(error: Error): void {
    const pending = this.pendingAcks;
    this.pendingAcks = [];
    for (const entry of pending) entry.reject(error);
  }
}
