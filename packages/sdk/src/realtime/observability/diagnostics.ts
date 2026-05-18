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
