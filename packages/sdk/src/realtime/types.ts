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

// Client-side WebRTC / ICE / networking observability events. Free-form
// payload; logged by bouncer under the session's existing log context and
// not forwarded upstream.
export type ObservabilityMessage = {
  type: "observability";
  data: unknown;
};

// Outgoing message types (to server)
export type OutgoingRealtimeMessage =
  | LiveKitJoinMessage
  | PromptMessage
  | SetImageMessage
  | ObservabilityMessage;

export type OutgoingMessage = PromptMessage | SetImageMessage;
