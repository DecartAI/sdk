import mitt, { type Emitter } from "mitt";
import pRetry, { AbortError } from "p-retry";

import { createConsoleLogger, type Logger } from "../utils/logger";
import { REALTIME_CONFIG } from "./config-realtime";
import type { MediaChannel, MediaChannelFactory, VideoCodec } from "./media-channel";
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
  SessionEnded,
  SessionStarted,
  SetImagePayload,
} from "./types";

type RetryAttemptError = Error & {
  attemptNumber?: number;
  retriesLeft?: number;
};

type ConnectionLossCause = Record<string, unknown>;

function isTerminalEndReason(reason: string | undefined): boolean {
  return reason !== undefined && (REALTIME_CONFIG.session.terminalEndReasons as readonly string[]).includes(reason);
}

/**
 * A policy close carries no `generation_ended` when the session is killed
 * before generation starts, so the close code is the only signal left.
 */
function terminalReasonFromClose(cause: ConnectionLossCause): string | null {
  return cause.code === REALTIME_CONFIG.session.terminalCloseCode ? "policy_violation" : null;
}

/**
 * The same close seen from the other side. SignalingChannel only emits `closed`
 * once the handshake has completed; a close before that rejects the pending
 * open instead, so during the initial join the code only ever reaches us as the
 * text of a connect failure. That window matters: the initial set_image is sent
 * on join, so a pre-first-frame policy kill lands right here.
 */
function terminalReasonFromError(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const marker = `websocket closed: ${REALTIME_CONFIG.session.terminalCloseCode}`;
  return error.message.toLowerCase().includes(marker) ? "policy_violation" : null;
}

export function encodeSubscribeToken(roomName: string, options: { frameTiming?: boolean } = {}): string {
  return btoa(JSON.stringify({ room_name: roomName, ...(options.frameTiming ? { frame_timing: true } : {}) }));
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
  sessionEnded: SessionEnded;
  remoteStream: MediaStream;
  error: Error;
};

interface StreamSessionConfig {
  url: string;
  integration?: string;
  observability?: RealtimeObservability;
  frameTiming?: boolean;
  localStream: MediaStream | null;
  initialImage?: string;
  initialImageRef?: string;
  initialPrompt?: InitialPrompt;
  initialPassthrough?: boolean;
  logger?: Logger;
  videoCodec?: VideoCodec;
  createMediaChannel: MediaChannelFactory;
}

export class StreamSession {
  private signaling!: SignalingChannel;
  private media!: MediaChannel;
  private events: Emitter<StreamSessionEvents> = mitt();

  private state: ConnectionState = "disconnected";
  private queue: QueuePosition | null = null;

  private disposed = false;
  private currentAttempt = 0;
  private teardownGeneration = 0;

  /** Set once the server reports a reason that must not be retried. */
  private terminalEndReason: string | null = null;

  /**
   * The state the caller has applied since connecting, replayed as the initial
   * state of a reconnect. Without it a reconnect restores whatever was passed
   * to `connect()`, which is usually nothing — callers normally send the image
   * after connecting. The replacement session then joins with no prompt and no
   * image, never starts generating, and leaves the caller on a "connected"
   * session that produces no frames.
   */
  private appliedState: InitialState | null = null;

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
    this.terminalEndReason = null;
    const attempt = ++this.currentAttempt;
    this.setState("connecting");
    this.logger.info("realtime connect: starting", { attemptCycle: attempt });

    try {
      await pRetry(() => this.runOneConnect(attempt), this.retryOptionsFor(attempt));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const terminal = this.terminalEndReason ?? terminalReasonFromError(error);
      if (terminal && !this.disposed) {
        // Refused rather than unreachable, so report it as a session that ended
        // instead of a connection that failed. connect() still rejects.
        this.finishTerminally(terminal, { source: "connect", error: message });
        throw error;
      }
      this.logger.error("realtime connect: exhausted all retries", { error: message });
      if (this.currentAttempt === attempt && !this.disposed) {
        this.setState("disconnected");
      }
      throw error;
    }
  }

  async sendPrompt(text: string, opts?: PromptSendOptions): Promise<void> {
    this.assertConnected();
    await this.signaling.sendPrompt(text, opts);
    // A prompt-only update, so whatever image is in effect stays in effect.
    // Merging onto getInitialState() rather than appliedState matters: until
    // the caller applies something, the image in effect is the connect-time
    // one, and merging onto a null appliedState would silently drop it.
    this.appliedState = { ...this.getInitialState(), prompt: text, enhance: opts?.enhance };
  }

  async setImage(payload: SetImagePayload, opts?: ImageSetOptions): Promise<void> {
    this.assertConnected();
    await this.signaling.setImage(payload, opts);
    // `set()` routes every update through here and the server treats it as a
    // whole-state replace, so record it the same way rather than merging.
    this.appliedState =
      payload.kind === "ref"
        ? { imageRef: payload.ref, prompt: opts?.prompt ?? null, enhance: opts?.enhance }
        : { image: payload.data, prompt: opts?.prompt ?? null, enhance: opts?.enhance };
  }

  async replaceVideoTrack(track: MediaStreamTrack): Promise<void> {
    this.assertConnected();
    await this.media.replaceVideoTrack(track);
    const previous = this.config.localStream;
    this.config.localStream = new MediaStream(previous ? [track, ...previous.getAudioTracks()] : [track]);
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
        // A terminal stop seen mid-handshake surfaces here as a plain connect
        // failure; retrying it just re-opens billed sessions.
        const terminal = this.terminalEndReason ?? terminalReasonFromError(error);
        if (terminal) {
          this.terminalEndReason = terminal;
          this.logger.error("realtime connect: session refused, not retrying", { reason: terminal });
          return false;
        }
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
      // Start the glass-to-glass TTFF clock for this attempt (resets the tracker).
      this.config.observability?.markGlassToGlassStart();

      const { roomInfo, initialStateAck } = await this.signaling.openAndJoin({
        connectTimeout: REALTIME_CONFIG.session.connectionTimeoutMs,
        initialState,
        passthrough: this.config.initialPassthrough,
        frameTiming: this.config.frameTiming,
      });
      this.watchInitialStateAck(initialStateAck, attempt);

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
        subscribeToken: encodeSubscribeToken(roomInfo.roomName, { frameTiming: this.config.frameTiming }),
      });
    } catch (error) {
      this.config.observability?.finishConnectionBreakdown({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private watchInitialStateAck(initialStateAck: Promise<void>, attempt: number): void {
    const generation = this.teardownGeneration;
    initialStateAck.catch((error) => {
      if (this.disposed || this.currentAttempt !== attempt || this.teardownGeneration !== generation) return;
      this.events.emit("error", error instanceof Error ? error : new Error(String(error)));
    });
  }

  /** The state a reconnect restores: what the caller applied, else what they opened with. */
  private getInitialState(): InitialState | undefined {
    return this.appliedState ?? this.configInitialState();
  }

  private configInitialState(): InitialState | undefined {
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

    return undefined;
  }

  private wireSignalingEvents(): void {
    this.signaling.on("queuePosition", (qp) => {
      this.queue = qp;
      this.events.emit("queuePosition", qp);
    });
    // The server signals generation start over the websocket. `generation_started`
    // fires immediately when generation begins; the first `generation_tick` is a
    // later fallback in case that message is ever absent.
    this.signaling.on("generationStarted", () => this.markGenerating());
    this.signaling.on("generationTick", (e) => {
      this.markGenerating();
      this.events.emit("generationTick", e);
    });
    this.signaling.on("generationEnded", (e) => {
      // Remembered rather than acted on here: the reason arrives just before
      // the close, and it is the close that would otherwise start a reconnect.
      if (isTerminalEndReason(e.reason)) this.terminalEndReason = e.reason;
      this.events.emit("generationEnded", e);
    });
    this.signaling.on("serverError", (err) => this.events.emit("error", err));
    this.signaling.on("closed", (info) => {
      // A policy close can land mid-handshake, before any generation_ended and
      // before the state reaches "connected" — the initial set_image is sent on
      // join and overlaps the media connect, which is exactly when a
      // pre-first-frame cut happens. Record the code here so both
      // handleConnectionLoss and the retry predicate can see it.
      if (this.isTerminalClose(info)) this.terminalEndReason ??= "policy_violation";
      this.handleConnectionLoss({ source: "signaling", ...info });
    });
  }

  private markGenerating(): void {
    if (this.state === "connected") this.setState("generating");
  }

  private wireMediaEvents(): void {
    this.media.on("remoteStream", (stream) => this.events.emit("remoteStream", stream));
    this.media.on("disconnected", (info) => this.handleConnectionLoss({ source: "media", reason: info.reason }));
  }

  private handleConnectionLoss(cause: ConnectionLossCause): void {
    if (this.disposed) return;

    // Checked BEFORE the state guard below: a terminal stop is worth acting on
    // even while still connecting, and the guard would otherwise drop it and
    // leave pRetry opening another billed session against the same policy.
    const terminalReason = this.terminalEndReason ?? terminalReasonFromClose(cause);
    if (terminalReason) {
      this.finishTerminally(terminalReason, cause);
      return;
    }

    if (this.state !== "connected" && this.state !== "generating") {
      this.logger.debug("connection loss ignored (not connected)", { state: this.state, ...cause });
      return;
    }
    this.logger.warn("realtime connection lost; scheduling reconnect", { state: this.state, ...cause });
    this.scheduleReconnect();
  }

  private isTerminalClose(cause: ConnectionLossCause): boolean {
    return terminalReasonFromClose(cause) !== null;
  }

  /**
   * The server ended this session on purpose. Retrying asks the same question
   * and gets the same answer, each retry costs a fresh billed session, and the
   * "reconnecting" state would overwrite the reason the caller needs to show.
   */
  private finishTerminally(reason: string, cause: ConnectionLossCause): void {
    this.logger.warn("realtime session ended by the server; not reconnecting", {
      reason,
      state: this.state,
      ...cause,
    });
    this.terminalEndReason = reason;
    this.disposed = true;
    this.tearDown();
    this.setState("disconnected");
    this.events.emit("sessionEnded", { reason });
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
    this.media = this.config.createMediaChannel({
      observability: this.config.observability,
      localStream: this.config.localStream,
      logger: this.logger,
      videoCodec: this.config.videoCodec,
    });
    this.wireSignalingEvents();
    this.wireMediaEvents();
  }

  private tearDown(): void {
    this.teardownGeneration++;
    this.signaling.close();
    this.media.disconnect();
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
