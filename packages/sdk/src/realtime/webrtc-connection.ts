import mitt from "mitt";
import type { RealTimeModels } from "../shared/model";
import type { Logger } from "../utils/logger";
import { buildUserAgent } from "../utils/user-agent";
import type { DiagnosticEmitter, IceCandidateEvent } from "./diagnostics";
import type {
  ConnectionState,
  GenerationTickMessage,
  IncomingWebRTCMessage,
  OutgoingWebRTCMessage,
  PromptAckMessage,
  SessionIdMessage,
  SetImageAckMessage,
  TurnConfig,
} from "./types";

const ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];
const AVATAR_SETUP_TIMEOUT_MS = 30_000; // 30 seconds

interface ConnectionCallbacks {
  onRemoteStream?: (stream: MediaStream) => void;
  onStateChange?: (state: ConnectionState) => void;
  onError?: (error: Error) => void;
  customizeOffer?: (offer: RTCSessionDescriptionInit) => Promise<void>;
  vp8MinBitrate?: number;
  vp8StartBitrate?: number;
  modelName?: RealTimeModels;
  initialImage?: string;
  initialPrompt?: { text: string; enhance?: boolean };
  logger?: Logger;
  onDiagnostic?: DiagnosticEmitter;
}

type WsMessageEvents = {
  promptAck: PromptAckMessage;
  setImageAck: SetImageAckMessage;
  sessionId: SessionIdMessage;
  generationTick: GenerationTickMessage;
};

const noopDiagnostic: DiagnosticEmitter = () => {};

export class WebRTCConnection {
  private pc: RTCPeerConnection | null = null;
  private ws: WebSocket | null = null;
  private localStream: MediaStream | null = null;
  private connectionReject: ((error: Error) => void) | null = null;
  private logger: Logger;
  private emitDiagnostic: DiagnosticEmitter;
  state: ConnectionState = "disconnected";
  websocketMessagesEmitter = mitt<WsMessageEvents>();
  constructor(private callbacks: ConnectionCallbacks = {}) {
    this.logger = callbacks.logger ?? { debug() {}, info() {}, warn() {}, error() {} };
    this.emitDiagnostic = callbacks.onDiagnostic ?? noopDiagnostic;
  }

  getPeerConnection(): RTCPeerConnection | null {
    return this.pc;
  }

  async connect(url: string, localStream: MediaStream | null, timeout: number, integration?: string): Promise<void> {
    const deadline = Date.now() + timeout;
    this.localStream = localStream;

    // Add user agent as query parameter (browsers don't support WS headers)
    const userAgent = encodeURIComponent(buildUserAgent(integration));
    const separator = url.includes("?") ? "&" : "?";
    const wsUrl = `${url}${separator}user_agent=${userAgent}`;

    // Shared abort mechanism: any phase failure aborts the entire connect flow.
    // connectionReject is set once and stays active across all phases so that
    // ws.onclose, server errors, or signaling failures during ANY phase abort immediately.
    let rejectConnect!: (error: Error) => void;
    const connectAbort = new Promise<never>((_, reject) => {
      rejectConnect = reject;
    });
    // Suppress unhandled rejection when connectAbort is not currently being raced
    connectAbort.catch(() => {});
    this.connectionReject = (error) => rejectConnect(error);

    const totalStart = performance.now();
    try {
      // Phase 1: WebSocket setup
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
              this.handleSignalingMessage(JSON.parse(e.data));
            } catch (err) {
              this.logger.error("Signaling message parse error", { error: String(err) });
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

      // Phase 2: Pre-handshake setup (initial image and/or prompt)
      // connectionReject is already active, so ws.onclose or server errors abort these too
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
      }

      // Phase 3: WebRTC handshake
      const handshakeStart = performance.now();
      await this.setupNewPeerConnection();
      await Promise.race([
        new Promise<void>((resolve, reject) => {
          const checkConnection = setInterval(() => {
            if (this.state === "connected" || this.state === "generating") {
              clearInterval(checkConnection);
              this.emitDiagnostic("phaseTiming", {
                phase: "webrtc-handshake",
                durationMs: performance.now() - handshakeStart,
                success: true,
              });
              resolve();
            } else if (this.state === "disconnected") {
              clearInterval(checkConnection);
              this.emitDiagnostic("phaseTiming", {
                phase: "webrtc-handshake",
                durationMs: performance.now() - handshakeStart,
                success: false,
                error: "Connection lost during handshake",
              });
              reject(new Error("Connection lost during WebRTC handshake"));
            } else if (Date.now() >= deadline) {
              clearInterval(checkConnection);
              this.emitDiagnostic("phaseTiming", {
                phase: "webrtc-handshake",
                durationMs: performance.now() - handshakeStart,
                success: false,
                error: "Timeout",
              });
              reject(new Error("Connection timeout"));
            }
          }, 100);
          // Clean up interval if connectAbort fires
          connectAbort.catch(() => clearInterval(checkConnection));
        }),
        connectAbort,
      ]);

      this.emitDiagnostic("phaseTiming", {
        phase: "total",
        durationMs: performance.now() - totalStart,
        success: true,
      });
    } finally {
      this.connectionReject = null;
    }
  }

  private async handleSignalingMessage(msg: IncomingWebRTCMessage): Promise<void> {
    try {
      // Handle messages that don't require peer connection first
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
        // Handled internally — not surfaced as a public event.
        // Devs use connectionChange for disconnect and error for insufficient credits.
        return;
      }

      if (msg.type === "session_id") {
        this.websocketMessagesEmitter.emit("sessionId", msg);
        return;
      }

      // All other messages require peer connection
      if (!this.pc) return;

      switch (msg.type) {
        case "ready": {
          await this.applyCodecPreference("video/VP8");
          const offer = await this.pc.createOffer();
          this.modifyVP8Bitrate(offer);
          await this.callbacks.customizeOffer?.(offer);
          await this.pc.setLocalDescription(offer);
          this.send({ type: "offer", sdp: offer.sdp || "" });
          break;
        }
        case "offer": {
          await this.pc.setRemoteDescription({ type: "offer", sdp: msg.sdp });
          const answer = await this.pc.createAnswer();
          await this.pc.setLocalDescription(answer);
          this.send({ type: "answer", sdp: answer.sdp || "" });
          break;
        }
        case "answer":
          await this.pc.setRemoteDescription({
            type: "answer",
            sdp: msg.sdp,
          });
          break;
        case "ice-candidate":
          if (msg.candidate) {
            await this.pc.addIceCandidate(msg.candidate);
            this.emitDiagnostic("iceCandidate", {
              source: "remote",
              candidateType:
                (msg.candidate.candidate?.match(/typ (\w+)/)?.[1] as IceCandidateEvent["candidateType"]) ?? "unknown",
              protocol:
                (msg.candidate.candidate?.match(/udp|tcp/i)?.[0]?.toLowerCase() as IceCandidateEvent["protocol"]) ??
                "unknown",
            });
          }
          break;
        case "ice-restart": {
          const turnConfig = msg.turn_config;
          if (turnConfig) {
            await this.setupNewPeerConnection(turnConfig);
          }
          break;
        }
      }
    } catch (error) {
      this.logger.error("Signaling handler error", { error: String(error) });
      this.callbacks.onError?.(error as Error);
      this.connectionReject?.(error as Error);
    }
  }

  send(message: OutgoingWebRTCMessage): boolean {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
      return true;
    }
    this.logger.warn("Message dropped: WebSocket is not open");
    return false;
  }

  async setImageBase64(
    imageBase64: string | null,
    options?: { prompt?: string; enhance?: boolean; timeout?: number },
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.websocketMessagesEmitter.off("setImageAck", listener);
        reject(new Error("Image send timed out"));
      }, options?.timeout ?? AVATAR_SETUP_TIMEOUT_MS);

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
        prompt?: string;
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

  /**
   * Send the initial prompt to the server before WebRTC handshake.
   */
  private async sendInitialPrompt(prompt: { text: string; enhance?: boolean }): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.websocketMessagesEmitter.off("promptAck", listener);
        reject(new Error("Prompt send timed out"));
      }, AVATAR_SETUP_TIMEOUT_MS);

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

  private async setupNewPeerConnection(turnConfig?: TurnConfig): Promise<void> {
    if (this.pc) {
      this.pc.getSenders().forEach((sender) => {
        if (sender.track && this.pc) {
          this.pc.removeTrack(sender);
        }
      });
      this.pc.close();
    }
    const iceServers: RTCIceServer[] = [...ICE_SERVERS];
    if (turnConfig) {
      iceServers.push({
        urls: turnConfig.server_url,
        credential: turnConfig.credential,
        username: turnConfig.username,
      });
    }
    this.pc = new RTCPeerConnection({ iceServers });
    this.setState("connecting");

    if (this.localStream) {
      // For live_avatar: add receive-only video transceiver (sends audio only, receives audio+video)
      if (this.callbacks.modelName === "live_avatar") {
        this.pc.addTransceiver("video", { direction: "recvonly" });
      }

      this.localStream.getTracks().forEach((track) => {
        if (this.pc && this.localStream) {
          this.pc.addTrack(track, this.localStream);
        }
      });
    } else {
      // Subscribe mode: receive-only transceivers for video and audio
      this.pc.addTransceiver("video", { direction: "recvonly" });
      this.pc.addTransceiver("audio", { direction: "recvonly" });
    }

    let fallbackStream: MediaStream | null = null;
    this.pc.ontrack = (e) => {
      if (e.streams?.[0]) {
        this.callbacks.onRemoteStream?.(e.streams[0]);
      } else {
        if (!fallbackStream) fallbackStream = new MediaStream();
        fallbackStream.addTrack(e.track);
        this.callbacks.onRemoteStream?.(fallbackStream);
      }
    };

    this.pc.onicecandidate = (e) => {
      this.send({ type: "ice-candidate", candidate: e.candidate });
      if (e.candidate) {
        this.emitDiagnostic("iceCandidate", {
          source: "local",
          candidateType: (e.candidate.type as IceCandidateEvent["candidateType"]) ?? "unknown",
          protocol: (e.candidate.protocol as IceCandidateEvent["protocol"]) ?? "unknown",
          address: e.candidate.address ?? undefined,
          port: e.candidate.port ?? undefined,
        });
      }
    };

    let prevPcState: string = "new";
    this.pc.onconnectionstatechange = () => {
      if (!this.pc) return;
      const s = this.pc.connectionState;
      this.emitDiagnostic("peerConnectionStateChange", {
        state: s,
        previousState: prevPcState,
        timestampMs: performance.now(),
      });
      prevPcState = s;

      if (s === "connected") {
        this.emitSelectedCandidatePair();
      }

      const nextState =
        s === "connected" ? "connected" : ["connecting", "new"].includes(s) ? "connecting" : "disconnected";
      // Keep "generating" sticky unless the connection is actually lost.
      if (this.state === "generating" && nextState !== "disconnected") return;
      this.setState(nextState);
    };

    let prevIceState: string = "new";
    this.pc.oniceconnectionstatechange = () => {
      if (!this.pc) return;
      const newIceState = this.pc.iceConnectionState;
      this.emitDiagnostic("iceStateChange", {
        state: newIceState,
        previousState: prevIceState,
        timestampMs: performance.now(),
      });
      prevIceState = newIceState;

      if (newIceState === "failed") {
        this.setState("disconnected");
        this.callbacks.onError?.(new Error("ICE connection failed"));
      }
    };

    let prevSignalingState: string = "stable";
    this.pc.onsignalingstatechange = () => {
      if (!this.pc) return;
      const newState = this.pc.signalingState;
      this.emitDiagnostic("signalingStateChange", {
        state: newState,
        previousState: prevSignalingState,
        timestampMs: performance.now(),
      });
      prevSignalingState = newState;
    };

    this.handleSignalingMessage({ type: "ready" });
  }

  private async emitSelectedCandidatePair(): Promise<void> {
    if (!this.pc) return;
    try {
      const stats = await this.pc.getStats();
      let found = false;
      stats.forEach((report) => {
        if (found) return;
        if (report.type === "candidate-pair" && report.state === "succeeded") {
          found = true;
          let localCandidate: Record<string, unknown> | undefined;
          let remoteCandidate: Record<string, unknown> | undefined;
          stats.forEach((r) => {
            if (r.id === report.localCandidateId) localCandidate = r as Record<string, unknown>;
            if (r.id === report.remoteCandidateId) remoteCandidate = r as Record<string, unknown>;
          });
          if (localCandidate && remoteCandidate) {
            this.emitDiagnostic("selectedCandidatePair", {
              local: {
                candidateType: String(localCandidate.candidateType ?? "unknown"),
                protocol: String(localCandidate.protocol ?? "unknown"),
                address: localCandidate.address as string | undefined,
                port: localCandidate.port as number | undefined,
              },
              remote: {
                candidateType: String(remoteCandidate.candidateType ?? "unknown"),
                protocol: String(remoteCandidate.protocol ?? "unknown"),
                address: remoteCandidate.address as string | undefined,
                port: remoteCandidate.port as number | undefined,
              },
            });
          }
        }
      });
    } catch {
      // getStats can fail if PC is already closed; silently ignore
    }
  }

  cleanup(): void {
    // Note: We intentionally do NOT stop the tracks here.
    // The tracks belong to the user's source stream, not the SDK.
    // Stopping them would break retries and local preview.
    //TODO: Think of this more carefully.
    this.pc?.close();
    this.pc = null;
    this.ws?.close();
    this.ws = null;
    this.localStream = null;
    this.setState("disconnected");
  }

  applyCodecPreference(preferredCodecName: "video/VP8" | "video/H264") {
    if (!this.pc) return;
    if (typeof RTCRtpSender === "undefined" || typeof RTCRtpSender.getCapabilities !== "function") {
      this.logger.debug("RTCRtpSender capabilities not available in this environment");
      return;
    }

    const videoTransceiver = this.pc
      .getTransceivers()
      .find((r) => r.sender.track?.kind === "video" || r.receiver.track?.kind === "video");
    if (!videoTransceiver) {
      this.logger.warn("Video transceiver not found for codec preference");
      return;
    }

    const capabilities = RTCRtpSender.getCapabilities("video");
    if (!capabilities) {
      this.logger.warn("Video sender capabilities unavailable");
      return;
    }

    const preferredCodecs: RTCRtpCodec[] = [];
    const otherCodecs: RTCRtpCodec[] = [];
    capabilities.codecs.forEach((codec) => {
      if (codec.mimeType.toLowerCase() === preferredCodecName.toLowerCase()) {
        preferredCodecs.push(codec);
      } else {
        otherCodecs.push(codec);
      }
    });

    const orderedCodecs = [...preferredCodecs, ...otherCodecs];
    if (orderedCodecs.length === 0) {
      this.logger.debug("No video codecs found for preference setting");
      return;
    }
    try {
      videoTransceiver.setCodecPreferences(orderedCodecs);
    } catch {
      this.logger.debug("setCodecPreferences not supported, skipping");
    }
  }

  private modifyVP8Bitrate(offer: RTCSessionDescriptionInit): void {
    if (!offer.sdp) return;

    const minBitrateInKbps = this.callbacks.vp8MinBitrate;
    const startBitrateInKbps = this.callbacks.vp8StartBitrate;

    if (minBitrateInKbps === undefined || startBitrateInKbps === undefined) {
      return;
    }

    if (minBitrateInKbps === 0 && startBitrateInKbps === 0) {
      return;
    }

    const bitrateParams = `x-google-min-bitrate=${minBitrateInKbps};x-google-start-bitrate=${startBitrateInKbps}`;

    const sdpLines = offer.sdp.split("\r\n");
    const modifiedLines: string[] = [];

    for (let i = 0; i < sdpLines.length; i++) {
      // Look for VP8 codec line (e.g., "a=rtpmap:96 VP8/90000")
      if (sdpLines[i].includes("VP8/90000")) {
        const match = sdpLines[i].match(/a=rtpmap:(\d+) VP8/);
        if (match) {
          const payloadType = match[1];

          // Find the range of lines for this payload type and where to insert fmtp
          let fmtpIndex = -1;
          let insertAfterIndex = i; // Default: insert after rtpmap line

          for (let j = i + 1; j < sdpLines.length && sdpLines[j].startsWith("a="); j++) {
            // Check if fmtp already exists
            if (sdpLines[j].startsWith(`a=fmtp:${payloadType}`)) {
              fmtpIndex = j;
              break;
            }
            // Update insert position to after rtcp-fb lines for this payload
            if (sdpLines[j].startsWith(`a=rtcp-fb:${payloadType}`)) {
              insertAfterIndex = j;
            }
            // Stop at next rtpmap (different codec)
            if (sdpLines[j].startsWith("a=rtpmap:")) {
              break;
            }
          }

          if (fmtpIndex !== -1) {
            // fmtp line exists, modify it in place
            if (!sdpLines[fmtpIndex].includes("x-google-min-bitrate")) {
              sdpLines[fmtpIndex] += `;${bitrateParams}`;
            }
          } else {
            // No fmtp line exists, we'll insert it after all rtcp-fb lines
            // Push lines up to and including the insert position
            for (let k = i; k <= insertAfterIndex; k++) {
              modifiedLines.push(sdpLines[k]);
            }
            // Insert the new fmtp line
            modifiedLines.push(`a=fmtp:${payloadType} ${bitrateParams}`);
            // Skip to after the insert position
            i = insertAfterIndex;
            continue;
          }
        }
      }
      modifiedLines.push(sdpLines[i]);
    }

    offer.sdp = modifiedLines.join("\r\n");
  }
}
