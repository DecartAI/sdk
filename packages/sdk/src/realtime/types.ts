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

export type RealtimeWebSocketErrorType =
  | "invalid_api_key"
  | "origin_not_allowed"
  | "invalid_model"
  | "removed_model"
  | "model_not_available_for_trial"
  | "insufficient_credits"
  | "upstream_capacity"
  | "upstream_rejected"
  | "upstream_timeout"
  | "model_server_disconnected"
  | "model_setup_timeout"
  | "session_duration_limit"
  | "session_not_found"
  | "server_shutdown"
  | "moderation_violation"
  | "internal_error";

export type RealtimeWebSocketErrorMessage = {
  type: "error";
  error: string;
  error_type?: RealtimeWebSocketErrorType;
} & Record<string, unknown>;

export type ErrorMessage = RealtimeWebSocketErrorMessage;

/** Wire shape: one of `image_data` or `image_ref` is set, not both. */
export type SetImageMessage = {
  type: "set_image";
  image_data?: string | null;
  image_ref?: string;
  prompt?: string | null;
  enhance_prompt?: boolean;
};

export type SetImagePayload = { kind: "data"; data: string | null } | { kind: "ref"; ref: string };

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

export type GenerationStartedMessage = {
  type: "generation_started";
};

export type LiveKitJoinMessage = {
  type: "livekit_join";
  initial_state?: SetImageMessage | PromptMessage | null;
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
  /** Pre-encoded base64 image; one of image/imageRef. */
  image?: string | null;
  /** Server file reference id; one of image/imageRef. */
  imageRef?: string;
  prompt?: string | null;
  enhance?: boolean;
};

export type InitialPrompt = {
  text: string;
  enhance?: boolean;
};

export type ServerError = Error & {
  source?: string;
  errorType?: RealtimeWebSocketErrorType;
  serverPayload?: RealtimeWebSocketErrorMessage;
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
  | GenerationStartedMessage
  | LiveKitRoomInfoMessage
  | QueuePositionMessage;

// Outgoing message types (to server)
export type OutgoingRealtimeMessage = LiveKitJoinMessage | PromptMessage | SetImageMessage;

export type OutgoingMessage = PromptMessage | SetImageMessage;
