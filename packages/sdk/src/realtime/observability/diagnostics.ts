export type ClientSessionConnectionBreakdownPhase = {
  phase: string;
  durationMs: number;
  success: boolean;
  error?: string;
};

export type ClientSessionConnectionBreakdownEvent = {
  attempt: number;
  success: boolean;
  totalDurationMs: number;
  initialImageSizeKb: number | null;
  phases: ClientSessionConnectionBreakdownPhase[];
  error?: string;
};

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
  stalled: boolean;
  durationMs: number;
};

export type DiagnosticEvents = {
  "client-session-connection-breakdown": ClientSessionConnectionBreakdownEvent;
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

type DiagnosticEventForName<K extends DiagnosticEventName> = {
  name: K;
  data: DiagnosticEvents[K];
};

export type DiagnosticEvent = {
  [K in DiagnosticEventName]: DiagnosticEventForName<K>;
}[DiagnosticEventName];

export type DiagnosticEmitter = <K extends DiagnosticEventName>(name: K, data: DiagnosticEvents[K]) => void;
