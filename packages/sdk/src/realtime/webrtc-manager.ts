import pRetry, { AbortError } from "p-retry";

import type { Logger } from "../utils/logger";
import type { DiagnosticEmitter } from "./diagnostics";
import { LiveKitConnection } from "./transports/livekit";
import type { TransportKind } from "./transports";
import type { ConnectionState, OutgoingMessage } from "./types";
import { WebRTCConnection } from "./webrtc-connection";
import type { StatsProvider } from "./webrtc-stats";

// Shared shape both connection types expose — narrows the union for
// WebRTCManager so both transports can be driven uniformly.
type TransportConnection = WebRTCConnection | LiveKitConnection;

export interface WebRTCConfig {
  webrtcUrl: string;
  integration?: string;
  logger?: Logger;
  onDiagnostic?: DiagnosticEmitter;
  onRemoteStream: (stream: MediaStream) => void;
  onConnectionStateChange?: (state: ConnectionState) => void;
  onError?: (error: Error) => void;
  customizeOffer?: (offer: RTCSessionDescriptionInit) => Promise<void>;
  vp8MinBitrate?: number;
  vp8StartBitrate?: number;
  modelName?: string;
  initialImage?: string;
  initialPrompt?: { text: string; enhance?: boolean };
  /**
   * Client-side publish options for the livekit transport. Ignored on
   * aiortc. Forwarded to `LocalParticipant.publishTrack(...)` in the
   * livekit transport. Useful for diagnostic/benchmark tooling — lets
   * callers cap the client's uplink encoder or toggle simulcast without
   * modifying SDK internals.
   *
   * `livekitPublishMaxBitrateKbps`: undefined → SDK default (2500 kbps);
   * `null` → explicit opt-out, no cap (let Chrome BWE run unclamped);
   * a positive number → explicit kbps value.
   */
  livekitPublishSimulcast?: boolean;
  livekitPublishMaxBitrateKbps?: number | null;
  /**
   * livekit-client `Room` options. Both default to `false`. Exposed for
   * the bench tool; enabling either changes quality/bandwidth
   * trade-offs, so leave them off in production unless you've verified
   * the behavior end-to-end.
   */
  livekitAdaptiveStream?: boolean;
  livekitDynacast?: boolean;
  /**
   * Client-side `publishTrack` knobs. Let the bench pin a codec to
   * match server-side, override the 30-fps default, or choose how
   * livekit-client degrades under bandwidth pressure.
   */
  livekitPublishCodec?: "vp8" | "vp9" | "h264" | "av1";
  livekitPublishMaxFramerate?: number;
  livekitDegradationPreference?: "balanced" | "maintain-framerate" | "maintain-resolution";
  /**
   * Selects the underlying WebRTC transport. Default is "aiortc" for
   * back-compat with existing deployments. Set to "livekit" to join a
   * LiveKit SFU room (requires the inference pod to enable it in
   * TRANSPORTS_ENABLED).
   */
  transport?: TransportKind;
  /**
   * TURN-TCP support (PR #116). aiortc-only — only consumed by
   * WebRTCConnection; LiveKitConnection ignores these (the SFU owns
   * its own ICE config). Pass-through still happens here so wiring
   * stays uniform across transports.
   *
   * `iceServers` — explicit STUN/TURN servers to merge into the
   *    RTCPeerConnection config.
   * `expectTurnConfig` — when true, WebRTCConnection.connect() awaits
   *    a `turn_config` WS message from the server before creating
   *    the peer connection, then merges the server-pushed creds.
   * `forceRelay` — when true, sets RTCConfiguration.iceTransportPolicy
   *    to "relay" (TURN-only).
   */
  iceServers?: RTCIceServer[];
  expectTurnConfig?: boolean;
  forceRelay?: boolean;
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

export class WebRTCManager {
  private connection: TransportConnection;
  private config: WebRTCConfig;
  private logger: Logger;
  private localStream: MediaStream | null = null;
  private subscribeMode = false;
  private managerState: ConnectionState = "disconnected";
  private hasConnected = false;
  private isReconnecting = false;
  private intentionalDisconnect = false;
  private reconnectGeneration = 0;

  constructor(config: WebRTCConfig) {
    this.config = config;
    this.logger = config.logger ?? { debug() {}, info() {}, warn() {}, error() {} };
    const transport: TransportKind = config.transport ?? "aiortc";
    const sharedOpts = {
      onRemoteStream: config.onRemoteStream,
      onStateChange: (state: ConnectionState) => this.handleConnectionStateChange(state),
      onError: config.onError,
      modelName: config.modelName,
      initialImage: config.initialImage,
      initialPrompt: config.initialPrompt,
      logger: this.logger,
      onDiagnostic: config.onDiagnostic,
    };
    if (transport === "livekit") {
      // TURN-TCP knobs (iceServers / expectTurnConfig / forceRelay)
      // are aiortc-only: the LiveKit SFU owns its own ICE config, so
      // we deliberately don't forward them here.
      this.connection = new LiveKitConnection({
        ...sharedOpts,
        publishSimulcast: config.livekitPublishSimulcast,
        publishMaxBitrateKbps: config.livekitPublishMaxBitrateKbps,
        adaptiveStream: config.livekitAdaptiveStream,
        dynacast: config.livekitDynacast,
        publishCodec: config.livekitPublishCodec,
        publishMaxFramerate: config.livekitPublishMaxFramerate,
        degradationPreference: config.livekitDegradationPreference,
      });
    } else {
      this.connection = new WebRTCConnection({
        ...sharedOpts,
        customizeOffer: config.customizeOffer,
        vp8MinBitrate: config.vp8MinBitrate,
        vp8StartBitrate: config.vp8StartBitrate,
        iceServers: config.iceServers,
        expectTurnConfig: config.expectTurnConfig,
        forceRelay: config.forceRelay,
      });
    }
    // Unconditional log so SDK consumers can verify the logger pipeline is wired
    // up regardless of transport or handshake outcome.
    this.logger.info("|||||||||||||||||||||||||||||||WebRTC transport selected", {
      transport,
      modelName: config.modelName,
    });
  }

  private emitState(state: ConnectionState): void {
    if (this.managerState !== state) {
      this.managerState = state;
      if (state === "connected" || state === "generating") this.hasConnected = true;
      this.config.onConnectionStateChange?.(state);
    }
  }

  private handleConnectionStateChange(state: ConnectionState): void {
    if (this.intentionalDisconnect) {
      this.emitState("disconnected");
      return;
    }

    // During reconnection, intercept state changes from the connection layer
    if (this.isReconnecting) {
      if (state === "connected" || state === "generating") {
        this.isReconnecting = false;
        this.emitState(state);
      }
      return;
    }

    // Unexpected disconnect after having been connected → trigger auto-reconnect
    // hasConnected guards against triggering during initial connect (which has its own retry loop)
    if (state === "disconnected" && !this.intentionalDisconnect && this.hasConnected) {
      this.reconnect();
      return;
    }

    this.emitState(state);
  }

  private async reconnect(): Promise<void> {
    if (this.isReconnecting || this.intentionalDisconnect) return;
    if (!this.subscribeMode && !this.localStream) return;

    const reconnectGeneration = ++this.reconnectGeneration;
    this.isReconnecting = true;
    this.emitState("reconnecting");
    const reconnectStart = performance.now();

    try {
      let attemptCount = 0;

      await pRetry(
        async () => {
          attemptCount++;

          if (this.intentionalDisconnect || reconnectGeneration !== this.reconnectGeneration) {
            throw new AbortError("Reconnect cancelled");
          }

          if (!this.subscribeMode && !this.localStream) {
            throw new AbortError("Reconnect cancelled: no local stream");
          }

          this.connection.cleanup();
          await this.connection.connect(
            this.config.webrtcUrl,
            this.localStream,
            CONNECTION_TIMEOUT,
            this.config.integration,
          );

          if (this.intentionalDisconnect || reconnectGeneration !== this.reconnectGeneration) {
            this.connection.cleanup();
            throw new AbortError("Reconnect cancelled");
          }
        },
        {
          ...RETRY_OPTIONS,
          onFailedAttempt: (error) => {
            if (this.intentionalDisconnect || reconnectGeneration !== this.reconnectGeneration) {
              return;
            }
            this.logger.warn("Reconnect attempt failed", { error: error.message, attempt: error.attemptNumber });
            this.config.onDiagnostic?.("reconnect", {
              attempt: error.attemptNumber,
              maxAttempts: RETRY_OPTIONS.retries + 1,
              durationMs: performance.now() - reconnectStart,
              success: false,
              error: error.message,
            });
            this.connection.cleanup();
          },
          shouldRetry: (error) => {
            if (this.intentionalDisconnect || reconnectGeneration !== this.reconnectGeneration) {
              return false;
            }
            const msg = error.message.toLowerCase();
            return !PERMANENT_ERRORS.some((err) => msg.includes(err));
          },
        },
      );
      this.config.onDiagnostic?.("reconnect", {
        attempt: attemptCount,
        maxAttempts: RETRY_OPTIONS.retries + 1,
        durationMs: performance.now() - reconnectStart,
        success: true,
      });
      // "connected" state is emitted by handleConnectionStateChange
    } catch (error) {
      this.isReconnecting = false;
      if (this.intentionalDisconnect || reconnectGeneration !== this.reconnectGeneration) {
        return;
      }
      this.emitState("disconnected");
      this.config.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async connect(localStream: MediaStream | null): Promise<boolean> {
    this.localStream = localStream;
    this.subscribeMode = localStream === null;
    this.intentionalDisconnect = false;
    this.hasConnected = false;
    this.isReconnecting = false;
    this.reconnectGeneration += 1;
    this.emitState("connecting");

    return pRetry(
      async () => {
        if (this.intentionalDisconnect) {
          throw new AbortError("Connect cancelled");
        }
        await this.connection.connect(this.config.webrtcUrl, localStream, CONNECTION_TIMEOUT, this.config.integration);
        return true;
      },
      {
        ...RETRY_OPTIONS,
        onFailedAttempt: (error) => {
          this.logger.warn("Connection attempt failed", { error: error.message, attempt: error.attemptNumber });
          this.connection.cleanup();
        },
        shouldRetry: (error) => {
          if (this.intentionalDisconnect) {
            return false;
          }
          const msg = error.message.toLowerCase();
          return !PERMANENT_ERRORS.some((err) => msg.includes(err));
        },
      },
    );
  }

  sendMessage(message: OutgoingMessage): boolean {
    return this.connection.send(message);
  }

  cleanup(): void {
    this.intentionalDisconnect = true;
    this.isReconnecting = false;
    this.reconnectGeneration += 1;
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

  getPeerConnection(): RTCPeerConnection | null {
    return this.connection.getPeerConnection();
  }

  /**
   * Stats source for WebRTCStatsCollector. For aiortc this is the raw
   * RTCPeerConnection; for livekit it's an aggregator over room tracks.
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
