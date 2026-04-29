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
  | LiveKitRoomInfoMessage;

// Outgoing message types (to server)
export type OutgoingRealtimeMessage = LiveKitJoinMessage | PromptMessage | SetAvatarImageMessage;

export type OutgoingMessage = PromptMessage | SetAvatarImageMessage;
