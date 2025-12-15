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
  candidate: RTCIceCandidate | null;
};

export type ReadyMessage = {
  type: "ready";
};

export type PromptMessage = {
  type: "prompt";
  prompt: string;
  enhance_prompt: boolean;
};

export type TurnConfig = {
  username: string;
  credential: string;
  server_url: string;
};

export type IceRestartMessage = {
  type: "ice-restart";
  turn_config: TurnConfig;
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
  type: "set_avatar_image";
  image: string; // Base64-encoded image data
};

export type AvatarReadyMessage = {
  type: "avatar_ready";
  success: boolean;
  error: string | null;
};

// Incoming message types (from server)
export type IncomingWebRTCMessage =
  | ReadyMessage
  | OfferMessage
  | AnswerMessage
  | IceCandidateMessage
  | IceRestartMessage
  | PromptAckMessage
  | ErrorMessage
  | AvatarReadyMessage;

// Outgoing message types (to server)
export type OutgoingWebRTCMessage =
  | OfferMessage
  | AnswerMessage
  | IceCandidateMessage
  | PromptMessage
  | SetAvatarImageMessage;

export type OutgoingMessage = PromptMessage | SetAvatarImageMessage;
