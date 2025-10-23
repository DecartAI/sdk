export type InitializeSessionMessage = {
	type: "initialize_session";
	product: "miragesdk";
	access_key: string;
	session_id: string;
	fps: number;
	prompt?: string;
	should_enrich?: boolean;
	rotateY?: number;
};

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

export type SwitchCameraMessage = {
	type: "switch_camera";
	rotateY: number;
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
	| InitializeSessionMessage
	| OfferMessage
	| AnswerMessage
	| IceCandidateMessage
	| PromptMessage
	| SwitchCameraMessage;

export type OutgoingMessage = PromptMessage | SwitchCameraMessage;
