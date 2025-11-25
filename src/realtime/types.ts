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

export type ErrorMessage = {
	type: "error";
	error: string;
};

// Incoming message types (from server)
export type IncomingWebRTCMessage =
	| ReadyMessage
	| OfferMessage
	| AnswerMessage
	| IceCandidateMessage
	| IceRestartMessage
	| ErrorMessage;

// Outgoing message types (to server)
export type OutgoingWebRTCMessage =
	| OfferMessage
	| AnswerMessage
	| IceCandidateMessage
	| PromptMessage;

export type OutgoingMessage = PromptMessage;
