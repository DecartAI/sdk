export type PromptMessage = {
  type: "prompt";
  prompt: string;
  enhance_prompt: boolean;
};

export type PromptAckMessage = {
  type: "prompt_ack";
  prompt: string;
  success: boolean;
  error: null | string;
};

export type ErrorMessage = {
  type: "error";
  error: string;
};

export type SetImageMessage = {
  type: "set_image";
  image_data: string | null;
  prompt?: string | null;
  enhance_prompt?: boolean;
};

export type SetImageAckMessage = {
  type: "set_image_ack";
  success: boolean;
  error: null | string;
};

export type GenerationTickMessage = GenerationTick & {
  type: "generation_tick";
};

export type GenerationEndedMessage = GenerationEnded & {
  type: "generation_ended";
};

export type LiveKitJoinMessage = {
  type: "livekit_join";
};

export type LiveKitRoomInfoMessage = {
  type: "livekit_room_info";
  livekit_url: string;
  token: string;
  room_name: string;
  session_id: string;
};

export type QueuePositionMessage = {
  type: "queue_position";
  position: number;
  queue_size: number;
};

export type QueuePosition = {
  position: number;
  queueSize: number;
};

export type ConnectionState = "connecting" | "connected" | "generating" | "disconnected" | "reconnecting";

export type ConnectionStatus = {
  connection: ConnectionState;
  queue: QueuePosition | null;
};

export type GenerationTick = {
  seconds: number;
};

export type GenerationEnded = {
  seconds: number;
  reason: string;
};

export type ConnectionClosed = {
  code: number;
  reason: string;
};

export type SessionStarted = {
  sessionId: string;
  subscribeToken: string;
};

export type InitialState = {
  image?: string | null;
  prompt?: string | null;
  enhance?: boolean;
};

export type InitialPrompt = {
  text: string;
  enhance?: boolean;
};

export type ServerError = Error & {
  source?: string;
};

export type PromptSendOptions = {
  enhance?: boolean;
  timeout?: number;
};

export type ImageSetOptions = {
  prompt?: string | null;
  enhance?: boolean;
  timeout?: number;
};

// Incoming message types (from server)
export type IncomingRealtimeMessage =
  | PromptAckMessage
  | ErrorMessage
  | SetImageAckMessage
  | GenerationTickMessage
  | GenerationEndedMessage
  | LiveKitRoomInfoMessage
  | QueuePositionMessage;

// Outgoing message types (to server)
export type OutgoingRealtimeMessage = LiveKitJoinMessage | PromptMessage | SetImageMessage;

export type OutgoingMessage = PromptMessage | SetImageMessage;

// --- aiortc-path types retained until PR 3 removes the aiortc transport ---

export type OfferMessage = {
  type: "offer";
  sdp: string;
};

export type AnswerMessage = {
  type: "answer";
  sdp: string;
};

export type IceCandidateMessage = {
  type: "ice-candidate";
  candidate: RTCIceCandidateInit | null;
};

export type ReadyMessage = {
  type: "ready";
};

export type SetAvatarImageMessage = SetImageMessage;

export type GenerationStartedMessage = {
  type: "generation_started";
};

export type SessionIdMessage = {
  type: "session_id";
  session_id: string;
  server_ip: string;
  server_port: number;
};

export type IncomingWebRTCMessage =
  | ReadyMessage
  | OfferMessage
  | AnswerMessage
  | IceCandidateMessage
  | PromptAckMessage
  | ErrorMessage
  | SetImageAckMessage
  | GenerationStartedMessage
  | GenerationTickMessage
  | GenerationEndedMessage
  | SessionIdMessage;

export type OutgoingWebRTCMessage =
  | OfferMessage
  | AnswerMessage
  | IceCandidateMessage
  | PromptMessage
  | SetImageMessage;
