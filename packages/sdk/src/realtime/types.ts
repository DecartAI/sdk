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

export type StatusMessage = {
  type: "status";
  status: string;
};

export type QueuePositionMessage = {
  type: "queue_position";
  position: number;
  queue_size: number;
};

export type GenerationTickMessage = {
  type: "generation_tick";
  seconds: number;
};

export type SessionIdMessage = {
  type: "session_id";
  session_id: string;
  server_ip: string;
  server_port: number;
};

export type LiveKitJoinMessage = {
  type: "livekit_join";
};

export type LiveKitRoomInfoMessage = {
  type: "livekit_room_info";
  livekit_url: string;
  token: string;
  room_name: string;
};

export type ConnectionState = "connecting" | "connected" | "generating" | "disconnected" | "reconnecting";

// Incoming message types (from server)
export type IncomingRealtimeMessage =
  | PromptAckMessage
  | ErrorMessage
  | SetImageAckMessage
  | GenerationTickMessage
  | SessionIdMessage
  | LiveKitRoomInfoMessage
  | StatusMessage
  | QueuePositionMessage;

// Outgoing message types (to server)
export type OutgoingRealtimeMessage = LiveKitJoinMessage | PromptMessage | SetImageMessage;

export type OutgoingMessage = PromptMessage | SetImageMessage;
