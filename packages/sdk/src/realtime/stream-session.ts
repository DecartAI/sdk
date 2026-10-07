import mitt, { type Emitter } from "mitt";
import pRetry, { AbortError } from "p-retry";

import { DecartSDKException, isDecartSDKError } from "../utils/errors";
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
  SessionEndReason,
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

const POLICY_VIOLATION: SessionEndReason = "policy_violation";
const SESSION_LIMIT: SessionEndReason = "session_limit";

function isSessionLimitClose(code: unknown, reason: unknown): boolean {
  const { closeCode, closeReason } = REALTIME_CONFIG.session.sessionLimit;
  return code === closeCode && typeof reason === "string" && reason.toLowerCase().includes(closeReason);
}

/**
 * The 1008 reason is only sent once generation has started; earlier kills carry just
 * the code. 1013 is terminal only with the session-limit reason: its other reason,
 * "Try Again Later", is a transient capacity refusal.
 */
function terminalReasonFromClose(cause: ConnectionLossCause): SessionEndReason | null {
  if (cause.code === REALTIME_CONFIG.session.terminalCloseCode) return POLICY_VIOLATION;
  if (isSessionLimitClose(cause.code, cause.reason)) return SESSION_LIMIT;
  return null;
}

/**
 * SignalingChannel only emits `closed` after the handshake, so a close during the
 * join reaches us as connect-failure text rather than an event. The session-limit
 * refusal is preceded by an `error` message, which is usually what rejects the join;
 * the 1013 close lands a tick later, so both texts are recognised.
 */
function terminalReasonFromError(error: unknown): SessionEndReason | null {
  if (!(error instanceof Error)) return null;
  const message = error.message.toLowerCase();
  const { terminalCloseCode, sessionLimit } = REALTIME_CONFIG.session;
  if (message.includes(`websocket closed: ${terminalCloseCode}`)) return POLICY_VIOLATION;
  if (message.includes(`websocket closed: ${sessionLimit.closeCode} ${sessionLimit.closeReason}`)) return SESSION_LIMIT;
  if (message.includes(sessionLimit.errorText)) return SESSION_LIMIT;
  return null;
}

/**
 * p-retry only accepts `Error` instances: a plain SDK error thrown inside a dial (an expired client
 * token, an `apiKeyProvider` rejection) is carried across the retry loop as a `DecartSDKException`.
 */
function toDialError(thrown: unknown): Error {
  if (thrown instanceof Error) return thrown;
  if (isDecartSDKError(thrown)) return new DecartSDKException(thrown);
  return new Error(String(thrown));
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
  /** Signaling URL of the first dial. */
  url: string;
  /**
   * Signaling URL for every later dial (connect retries and reconnects), resolved right before the
   * socket opens so it can carry a freshly minted client token. Defaults to `url`. An SDK error
   * thrown here whose code is in `permanentErrorCodes` ends the dial attempts.
   */
  redialUrl?: () => string | Promise<string>;
  integration?: string;
  observability?: RealtimeObservability;
  frameTiming?: boolean;
  localStream: MediaStream | null;
  initialImage?: string;
  initialImageRef?: string;
  initialPrompt?: InitialPrompt;
  initialPassthrough?: boolean;
  /** Re-dials of a failed `connect()` before it rejects; `0` dials once. Defaults to the config budget. */
  connectRetries?: number;
  logger?: Logger;
  videoCodec?: VideoCodec;
  remoteAudio?: boolean;
  createMediaChannel: MediaChannelFactory;
}

export class StreamSession {
  private signaling!: SignalingChannel;
  private media!: MediaChannel;
  private events: Emitter<StreamSessionEvents> = mitt();

  private state: ConnectionState = "disconnected";
  private queue: QueuePosition | null = null;

  private disposed = false;
  private dialed = false;
  private currentAttempt = 0;
  private teardownGeneration = 0;

  private terminalEndReason: string | null = null;

  /**
   * Replayed as a reconnect's initial state. Callers usually connect first and
   * send the image after, so without this the new session joins with nothing
   * applied and never starts generating.
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
      await pRetry(() => this.runOneConnect(attempt), this.retryOptionsFor(attempt, this.config.connectRetries));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const terminal = this.terminalEndReason ?? terminalReasonFromError(error);
      if (terminal) {
        // Already disposed when the refusing socket's close event got here first.
        if (!this.disposed) this.finishTerminally(terminal, { source: "connect", error: message });
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
    // Merged onto the effective state, not appliedState: until the caller applies
    // something the image in effect is the connect-time one, which must survive.
    this.appliedState = { ...this.getInitialState(), prompt: text, enhance: opts?.enhance };
  }

  async setImage(payload: SetImagePayload, opts?: ImageSetOptions): Promise<void> {
    this.assertConnected();
    await this.signaling.setImage(payload, opts);
    // The server treats this as a whole-state replace, so record it that way.
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

  private retryOptionsFor(attempt: number, retries: number = REALTIME_CONFIG.session.retry.retries) {
    return {
      ...REALTIME_CONFIG.session.retry,
      retries,
      onFailedAttempt: (_error: RetryAttemptError) => {
        this.tearDown();
      },
      shouldRetry: (error: Error) => {
        if (this.disposed || this.currentAttempt !== attempt) return false;
        const terminal = this.terminalEndReason ?? terminalReasonFromError(error);
        if (terminal) {
          this.terminalEndReason = terminal;
          this.logger.error("realtime connect: session refused, not retrying", { reason: terminal });
          return false;
        }
        const sdkCode = error instanceof DecartSDKException ? error.sdkError.code : undefined;
        if (sdkCode && (REALTIME_CONFIG.session.permanentErrorCodes as readonly string[]).includes(sdkCode)) {
          this.logger.error("realtime connect: credential refused, not retrying", {
            code: sdkCode,
            error: error.message,
          });
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
    } catch (thrown) {
      const error = toDialError(thrown);
      this.config.observability?.finishConnectionBreakdown({ success: false, error: error.message });
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
      // Recorded, not acted on: the following close is what would reconnect.
      if (isTerminalEndReason(e.reason)) this.terminalEndReason = e.reason;
      this.events.emit("generationEnded", e);
    });
    this.signaling.on("serverError", (err) => this.events.emit("error", err));
    this.signaling.on("closed", (info) => {
      this.terminalEndReason ??= terminalReasonFromClose({ ...info });
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

    // Before the state guard: a terminal stop still counts while connecting.
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

  /**
   * The server ended this session on purpose: retrying would get the same answer
   * and bill another session, and "reconnecting" would hide the reason.
   */
  private finishTerminally(reason: string, cause: ConnectionLossCause): void {
    // The cause's own `reason` is the raw close text; the SDK reason must win.
    this.logger.warn("realtime session ended by the server; not reconnecting", {
      ...cause,
      reason,
      state: this.state,
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
        // A cut of the replayed image lands here; it is a session end, not a failure.
        const terminal = this.terminalEndReason ?? terminalReasonFromError(error);
        if (terminal) {
          this.finishTerminally(terminal, { source: "reconnect", error: message });
          return;
        }
        this.logger.error("realtime reconnect: failed permanently", { error: message });
        this.tearDown();
        this.setState("disconnected");
        this.events.emit("error", error instanceof Error ? error : new Error(String(error)));
      });
  }

  /** The first dial uses the connect-time URL; every later one asks `redialUrl`. */
  private resolveDialUrl(): string | Promise<string> {
    const redial = this.dialed ? this.config.redialUrl : undefined;
    this.dialed = true;
    if (!redial) return this.config.url;
    const url = redial();
    if (typeof url === "string") return url;
    const attempt = this.currentAttempt;
    return url.then((resolved) => {
      // Disconnected or superseded while the credential was being fetched: do not dial at all.
      if (this.disposed || this.currentAttempt !== attempt) throw new AbortError("Stale connect attempt");
      return resolved;
    });
  }

  private createTransport(): void {
    this.signaling = new SignalingChannel({
      url: () => this.resolveDialUrl(),
      integration: this.config.integration,
      logger: this.logger,
      observability: this.config.observability,
    });
    this.media = this.config.createMediaChannel({
      observability: this.config.observability,
      localStream: this.config.localStream,
      logger: this.logger,
      videoCodec: this.config.videoCodec,
      remoteAudio: this.config.remoteAudio,
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
