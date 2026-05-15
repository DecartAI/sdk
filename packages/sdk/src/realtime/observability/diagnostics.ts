/** Connection phase names for timing events. */
export type ConnectionPhase = "websocket" | "avatar-image" | "initial-prompt" | "webrtc-handshake" | "total";

export type PhaseTimingEvent = {
  phase: ConnectionPhase;
  durationMs: number;
  success: boolean;
  error?: string;
};

export type IceCandidateEvent = {
  source: "local" | "remote";
  candidateType: "host" | "srflx" | "prflx" | "relay" | "unknown";
  protocol: "udp" | "tcp" | "unknown";
  address?: string;
  port?: number;
};

export type IceStateEvent = {
  state: string;
  previousState: string;
  timestampMs: number;
};

export type PeerConnectionStateEvent = {
  state: string;
  previousState: string;
  timestampMs: number;
};

export type SignalingStateEvent = {
  state: string;
  previousState: string;
  timestampMs: number;
};

export type SelectedCandidatePairEvent = {
  local: {
    candidateType: string;
    protocol: string;
    address?: string;
    port?: number;
  };
  remote: {
    candidateType: string;
    protocol: string;
    address?: string;
    port?: number;
  };
};

export type ReconnectEvent = {
  attempt: number;
  maxAttempts: number;
  durationMs: number;
  success: boolean;
  error?: string;
};

export type VideoStallEvent = {
  /** True when a stall is detected, false when recovered. */
  stalled: boolean;
  /** Duration of the stall in ms (0 when stall first detected, actual duration on recovery). */
  durationMs: number;
};

/** All diagnostic event types keyed by name. */
export type DiagnosticEvents = {
  phaseTiming: PhaseTimingEvent;
  iceCandidate: IceCandidateEvent;
  iceStateChange: IceStateEvent;
  peerConnectionStateChange: PeerConnectionStateEvent;
  signalingStateChange: SignalingStateEvent;
  selectedCandidatePair: SelectedCandidatePairEvent;
  reconnect: ReconnectEvent;
  videoStall: VideoStallEvent;
};

export type DiagnosticEventName = keyof DiagnosticEvents;

/** A single diagnostic event with its name and typed data. */
export type DiagnosticEvent = {
  [K in DiagnosticEventName]: { name: K; data: DiagnosticEvents[K] };
}[DiagnosticEventName];

/** Callback for emitting diagnostic events from the connection/manager layers. */
export type DiagnosticEmitter = <K extends DiagnosticEventName>(name: K, data: DiagnosticEvents[K]) => void;
