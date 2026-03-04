import mitt from "mitt";

import type { Logger } from "../utils/logger";
import { buildUserAgent } from "../utils/user-agent";
import type { DiagnosticEmitter } from "./diagnostics";
import type {
  ConnectionState,
  IncomingIVSMessage,
  OutgoingIVSMessage,
  PromptAckMessage,
  SetImageAckMessage,
  WsMessageEvents,
} from "./types";

// ── IVS SDK type declarations ─────────────────────────────────────────
// Minimal type surface for @aws/ivs-web-broadcast so the SDK compiles
// even when the package is not installed.

interface IVSStageStrategy {
  stageStreamsToPublish(stage: IVSStage): IVSLocalStageStream[];
  shouldPublishParticipant(stage: IVSStage, participant: IVSStageParticipant): boolean;
  shouldSubscribeToParticipant(stage: IVSStage, participant: IVSStageParticipant): IVSSubscribeType;
}

interface IVSStage {
  join(): Promise<void>;
  leave(): void;
  on(event: string, handler: (...args: unknown[]) => void): void;
}

interface IVSStageParticipant {
  isLocal: boolean;
}

interface IVSStageStream {
  mediaStreamTrack: MediaStreamTrack;
}

// biome-ignore lint/suspicious/noEmptyInterface: marker type for IVS SDK local stage stream
interface IVSLocalStageStream {}

declare enum IVSSubscribeType {
  NONE = "NONE",
  AUDIO_VIDEO = "AUDIO_VIDEO",
}

declare enum IVSStreamType {
  VIDEO = "VIDEO",
  AUDIO = "AUDIO",
}

declare enum IVSStageEvents {
  STAGE_CONNECTION_STATE_CHANGED = "STAGE_CONNECTION_STATE_CHANGED",
  STAGE_PARTICIPANT_STREAMS_ADDED = "STAGE_PARTICIPANT_STREAMS_ADDED",
}

declare enum IVSConnectionState {
  CONNECTED = "CONNECTED",
  DISCONNECTED = "DISCONNECTED",
}

interface IVSBroadcastModule {
  Stage: new (token: string, strategy: IVSStageStrategy) => IVSStage;
  LocalStageStream: new (track: MediaStreamTrack) => IVSLocalStageStream;
  SubscribeType: typeof IVSSubscribeType;
  StreamType: typeof IVSStreamType;
  StageEvents: typeof IVSStageEvents;
  ConnectionState: typeof IVSConnectionState;
}

// ── Dynamic loader ────────────────────────────────────────────────────

async function getIVSBroadcastClient(): Promise<IVSBroadcastModule> {
  try {
    const moduleName = "@aws/ivs-web-broadcast";
    // biome-ignore lint/suspicious/noExplicitAny: dynamic import of optional dependency
    const mod = (await (Function(`return import("${moduleName}")`)() as Promise<any>));
    return mod.default ?? mod;
  } catch {
    if (typeof globalThis !== "undefined" && "IVSBroadcastClient" in globalThis) {
      // biome-ignore lint/suspicious/noExplicitAny: global fallback
      return (globalThis as any).IVSBroadcastClient as IVSBroadcastModule;
    }
    throw new Error("@aws/ivs-web-broadcast not found. Install via npm or load via script tag.");
  }
}

// ── Types ─────────────────────────────────────────────────────────────

const SETUP_TIMEOUT_MS = 30_000;

interface IVSConnectionCallbacks {
  onRemoteStream?: (stream: MediaStream) => void;
  onStateChange?: (state: ConnectionState) => void;
  onError?: (error: Error) => void;
  modelName?: string;
  initialImage?: string;
  initialPrompt?: { text: string; enhance?: boolean };
  logger?: Logger;
  onDiagnostic?: DiagnosticEmitter;
}

const noopDiagnostic: DiagnosticEmitter = () => {};

// ── Connection ────────────────────────────────────────────────────────

export class IVSConnection {
  private ws: WebSocket | null = null;
  private publishStage: IVSStage | null = null;
  private subscribeStage: IVSStage | null = null;
  private connectionReject: ((error: Error) => void) | null = null;
  private logger: Logger;
  private emitDiagnostic: DiagnosticEmitter;
  state: ConnectionState = "disconnected";
  websocketMessagesEmitter = mitt<WsMessageEvents>();

  constructor(private callbacks: IVSConnectionCallbacks = {}) {
    this.logger = callbacks.logger ?? { debug() {}, info() {}, warn() {}, error() {} };
    this.emitDiagnostic = callbacks.onDiagnostic ?? noopDiagnostic;
  }

  async connect(url: string, localStream: MediaStream | null, timeout: number, integration?: string): Promise<void> {
    // Phase 1: WebSocket
    const userAgent = encodeURIComponent(buildUserAgent(integration));
    const separator = url.includes("?") ? "&" : "?";
    const wsUrl = `${url}${separator}user_agent=${userAgent}`;

    let rejectConnect!: (error: Error) => void;
    const connectAbort = new Promise<never>((_, reject) => {
      rejectConnect = reject;
    });
    connectAbort.catch(() => {});
    this.connectionReject = (error) => rejectConnect(error);

    const totalStart = performance.now();
    try {
      const wsStart = performance.now();
      await Promise.race([
        new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("WebSocket timeout")), timeout);
          this.ws = new WebSocket(wsUrl);

          this.ws.onopen = () => {
            clearTimeout(timer);
            this.emitDiagnostic("phaseTiming", {
              phase: "websocket",
              durationMs: performance.now() - wsStart,
              success: true,
            });
            resolve();
          };
          this.ws.onmessage = (e) => {
            try {
              this.handleMessage(JSON.parse(e.data));
            } catch (err) {
              this.logger.error("Message parse error", { error: String(err) });
            }
          };
          this.ws.onerror = () => {
            clearTimeout(timer);
            const error = new Error("WebSocket error");
            this.emitDiagnostic("phaseTiming", {
              phase: "websocket",
              durationMs: performance.now() - wsStart,
              success: false,
              error: error.message,
            });
            reject(error);
            rejectConnect(error);
          };
          this.ws.onclose = () => {
            this.setState("disconnected");
            clearTimeout(timer);
            reject(new Error("WebSocket closed before connection was established"));
            rejectConnect(new Error("WebSocket closed"));
          };
        }),
        connectAbort,
      ]);

      this.setState("connecting");

      // Phase 2: Pre-handshake (initial image/prompt — same as WebRTC)
      if (this.callbacks.initialImage) {
        const imageStart = performance.now();
        await Promise.race([
          this.setImageBase64(this.callbacks.initialImage, {
            prompt: this.callbacks.initialPrompt?.text,
            enhance: this.callbacks.initialPrompt?.enhance,
          }),
          connectAbort,
        ]);
        this.emitDiagnostic("phaseTiming", {
          phase: "avatar-image",
          durationMs: performance.now() - imageStart,
          success: true,
        });
      } else if (this.callbacks.initialPrompt) {
        const promptStart = performance.now();
        await Promise.race([this.sendInitialPrompt(this.callbacks.initialPrompt), connectAbort]);
        this.emitDiagnostic("phaseTiming", {
          phase: "initial-prompt",
          durationMs: performance.now() - promptStart,
          success: true,
        });
      } else if (localStream) {
        const nullStart = performance.now();
        await Promise.race([this.setImageBase64(null, { prompt: null }), connectAbort]);
        this.emitDiagnostic("phaseTiming", {
          phase: "initial-prompt",
          durationMs: performance.now() - nullStart,
          success: true,
        });
      }

      // Phase 3: IVS Stage setup — wait for ivs_stage_ready, then join stages
      const stageStart = performance.now();
      await Promise.race([this.setupIVSStages(localStream, timeout), connectAbort]);
      this.emitDiagnostic("phaseTiming", {
        phase: "ivs-stage-setup",
        durationMs: performance.now() - stageStart,
        success: true,
      });

      this.emitDiagnostic("phaseTiming", {
        phase: "total",
        durationMs: performance.now() - totalStart,
        success: true,
      });
    } finally {
      this.connectionReject = null;
    }
  }

  private async setupIVSStages(localStream: MediaStream | null, timeout: number): Promise<void> {
    const ivs = await getIVSBroadcastClient();

    // Wait for bouncer to send ivs_stage_ready
    const stageReady = await new Promise<{
      client_publish_token: string;
      client_subscribe_token: string;
    }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("IVS stage ready timeout")), timeout);

      const handler = (e: MessageEvent) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === "ivs_stage_ready") {
            clearTimeout(timer);
            if (this.ws) {
              this.ws.removeEventListener("message", handler);
            }
            resolve({
              client_publish_token: msg.client_publish_token,
              client_subscribe_token: msg.client_subscribe_token,
            });
          }
        } catch {
          // ignore parse errors, handled by main onmessage
        }
      };

      this.ws?.addEventListener("message", handler);
    });

    // Subscribe stage — receive remote video/audio
    const remoteStreamPromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("IVS subscribe stream timeout")), timeout);

      const subscribeStrategy: IVSStageStrategy = {
        stageStreamsToPublish: () => [],
        shouldPublishParticipant: () => false,
        shouldSubscribeToParticipant: (_stage, participant) =>
          participant.isLocal ? ivs.SubscribeType.NONE : ivs.SubscribeType.AUDIO_VIDEO,
      };

      this.subscribeStage = new ivs.Stage(stageReady.client_subscribe_token, subscribeStrategy);

      this.subscribeStage.on(ivs.StageEvents.STAGE_PARTICIPANT_STREAMS_ADDED, (...args: unknown[]) => {
        const participant = args[0] as IVSStageParticipant;
        const streams = args[1] as IVSStageStream[];
        if (participant.isLocal) return;

        clearTimeout(timer);
        const remoteStream = new MediaStream();
        for (const s of streams) {
          remoteStream.addTrack(s.mediaStreamTrack);
        }
        this.callbacks.onRemoteStream?.(remoteStream);
        resolve();
      });

      this.subscribeStage.on(ivs.StageEvents.STAGE_CONNECTION_STATE_CHANGED, (...args: unknown[]) => {
        const state = args[0] as string;
        if (state === ivs.ConnectionState.DISCONNECTED.toString()) {
          clearTimeout(timer);
          this.setState("disconnected");
        }
      });

      this.subscribeStage.join().catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    // Publish stage — send local camera track
    if (localStream) {
      const videoTrack = localStream.getVideoTracks()[0];
      const localStageStreams: IVSLocalStageStream[] = [];

      if (videoTrack) {
        localStageStreams.push(new ivs.LocalStageStream(videoTrack));
      }

      const publishStrategy: IVSStageStrategy = {
        stageStreamsToPublish: () => localStageStreams,
        shouldPublishParticipant: (_stage, participant) => participant.isLocal,
        shouldSubscribeToParticipant: () => ivs.SubscribeType.NONE,
      };

      this.publishStage = new ivs.Stage(stageReady.client_publish_token, publishStrategy);

      this.publishStage.on(ivs.StageEvents.STAGE_CONNECTION_STATE_CHANGED, (...args: unknown[]) => {
        const state = args[0] as string;
        if (state === ivs.ConnectionState.CONNECTED.toString()) {
          // Notify bouncer that we've joined the publish stage
          this.send({ type: "ivs_joined" });
          this.setState("connected");
        } else if (state === ivs.ConnectionState.DISCONNECTED.toString()) {
          this.setState("disconnected");
        }
      });

      await this.publishStage.join();
    }

    // Wait for remote stream from subscribe stage
    await remoteStreamPromise;
  }

  private handleMessage(msg: IncomingIVSMessage): void {
    try {
      if (msg.type === "error") {
        const error = new Error(msg.error) as Error & { source?: string };
        error.source = "server";
        this.callbacks.onError?.(error);
        if (this.connectionReject) {
          this.connectionReject(error);
          this.connectionReject = null;
        }
        return;
      }

      if (msg.type === "set_image_ack") {
        this.websocketMessagesEmitter.emit("setImageAck", msg);
        return;
      }

      if (msg.type === "prompt_ack") {
        this.websocketMessagesEmitter.emit("promptAck", msg);
        return;
      }

      if (msg.type === "generation_started") {
        this.setState("generating");
        return;
      }

      if (msg.type === "generation_tick") {
        this.websocketMessagesEmitter.emit("generationTick", msg);
        return;
      }

      if (msg.type === "generation_ended") {
        return;
      }

      if (msg.type === "session_id") {
        this.websocketMessagesEmitter.emit("sessionId", msg);
        return;
      }

      // ivs_stage_ready is handled separately in setupIVSStages via addEventListener
    } catch (error) {
      this.logger.error("Message handler error", { error: String(error) });
      this.callbacks.onError?.(error as Error);
      this.connectionReject?.(error as Error);
    }
  }

  send(message: OutgoingIVSMessage): boolean {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
      return true;
    }
    this.logger.warn("Message dropped: WebSocket is not open");
    return false;
  }

  async setImageBase64(
    imageBase64: string | null,
    options?: { prompt?: string | null; enhance?: boolean; timeout?: number },
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.websocketMessagesEmitter.off("setImageAck", listener);
        reject(new Error("Image send timed out"));
      }, options?.timeout ?? SETUP_TIMEOUT_MS);

      const listener = (msg: SetImageAckMessage) => {
        clearTimeout(timeoutId);
        this.websocketMessagesEmitter.off("setImageAck", listener);
        if (msg.success) {
          resolve();
        } else {
          reject(new Error(msg.error ?? "Failed to send image"));
        }
      };

      this.websocketMessagesEmitter.on("setImageAck", listener);

      const message: {
        type: "set_image";
        image_data: string | null;
        prompt?: string | null;
        enhance_prompt?: boolean;
      } = {
        type: "set_image",
        image_data: imageBase64,
      };

      if (options?.prompt !== undefined) {
        message.prompt = options.prompt;
      }
      if (options?.enhance !== undefined) {
        message.enhance_prompt = options.enhance;
      }

      if (!this.send(message)) {
        clearTimeout(timeoutId);
        this.websocketMessagesEmitter.off("setImageAck", listener);
        reject(new Error("WebSocket is not open"));
      }
    });
  }

  private async sendInitialPrompt(prompt: { text: string; enhance?: boolean }): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.websocketMessagesEmitter.off("promptAck", listener);
        reject(new Error("Prompt send timed out"));
      }, SETUP_TIMEOUT_MS);

      const listener = (msg: PromptAckMessage) => {
        if (msg.prompt === prompt.text) {
          clearTimeout(timeoutId);
          this.websocketMessagesEmitter.off("promptAck", listener);
          if (msg.success) {
            resolve();
          } else {
            reject(new Error(msg.error ?? "Failed to send prompt"));
          }
        }
      };

      this.websocketMessagesEmitter.on("promptAck", listener);

      if (
        !this.send({
          type: "prompt",
          prompt: prompt.text,
          enhance_prompt: prompt.enhance ?? true,
        })
      ) {
        clearTimeout(timeoutId);
        this.websocketMessagesEmitter.off("promptAck", listener);
        reject(new Error("WebSocket is not open"));
      }
    });
  }

  private setState(state: ConnectionState): void {
    if (this.state !== state) {
      this.state = state;
      this.callbacks.onStateChange?.(state);
    }
  }

  cleanup(): void {
    this.publishStage?.leave();
    this.publishStage = null;
    this.subscribeStage?.leave();
    this.subscribeStage = null;
    this.ws?.close();
    this.ws = null;
    this.setState("disconnected");
  }
}
