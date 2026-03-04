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

// Avatar Live message types
export type SetAvatarImageMessage = {
  type: "set_image";
  image_data: string | null; // Base64-encoded image data, or null to clear/use placeholder
  prompt?: string | null; // Optional prompt to send with the image, null for passthrough
  enhance_prompt?: boolean; // Optional flag to enhance the prompt
};

export type SetImageAckMessage = {
  type: "set_image_ack";
  success: boolean;
  error: null | string;
};

export type GenerationStartedMessage = {
  type: "generation_started";
};

export type GenerationTickMessage = {
  type: "generation_tick";
  seconds: number;
};

export type GenerationEndedMessage = {
  type: "generation_ended";
  seconds: number;
  reason: string;
};

export type SessionIdMessage = {
  type: "session_id";
  session_id: string;
  server_ip: string;
  server_port: number;
};

export type ConnectionState = "connecting" | "connected" | "generating" | "disconnected" | "reconnecting";

// Incoming message types (from server)
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

// Outgoing message types (to server)
export type OutgoingWebRTCMessage =
  | OfferMessage
  | AnswerMessage
  | IceCandidateMessage
  | PromptMessage
  | SetAvatarImageMessage;

export type OutgoingMessage = PromptMessage | SetAvatarImageMessage;

// IVS message types
export type IvsStageReadyMessage = {
  type: "ivs_stage_ready";
  stage_arn: string;
  client_publish_token: string;
  client_subscribe_token: string;
};

export type IvsJoinedMessage = {
  type: "ivs_joined";
};

// IVS incoming messages (from bouncer)
export type IncomingIVSMessage =
  | IvsStageReadyMessage
  | PromptAckMessage
  | ErrorMessage
  | SetImageAckMessage
  | GenerationStartedMessage
  | GenerationTickMessage
  | GenerationEndedMessage
  | SessionIdMessage;

// IVS outgoing messages (to bouncer)
export type OutgoingIVSMessage = IvsJoinedMessage | PromptMessage | SetAvatarImageMessage;

// Shared WebSocket message events (used by both WebRTC and IVS transports)
export type WsMessageEvents = {
  promptAck: PromptAckMessage;
  setImageAck: SetImageAckMessage;
  sessionId: SessionIdMessage;
  generationTick: GenerationTickMessage;
};
