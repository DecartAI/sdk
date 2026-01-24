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
  type: "set_image";
  image_data: string | null; // Base64-encoded image data, or null to clear/use placeholder
  prompt?: string; // Optional prompt to send with the image
  enhance_prompt?: boolean; // Optional flag to enhance the prompt
};

export type SetImageAckMessage = {
  type: "set_image_ack";
  success: boolean;
  error: null | string;
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
  | SetImageAckMessage;

// Outgoing message types (to server)
export type OutgoingWebRTCMessage =
  | OfferMessage
  | AnswerMessage
  | IceCandidateMessage
  | PromptMessage
  | SetAvatarImageMessage;

export type OutgoingMessage = PromptMessage | SetAvatarImageMessage;
