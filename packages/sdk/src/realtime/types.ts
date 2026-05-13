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

export type GenerationTickMessage = {
  type: "generation_tick";
  seconds: number;
};

export type GenerationEndedMessage = {
  type: "generation_ended";
  seconds: number;
  reason: string;
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

export type InitialState = {
  image?: string;
  prompt?: string;
  enhance?: boolean;
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
