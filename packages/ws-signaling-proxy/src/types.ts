export interface OfferMessage {
	type: "offer";
	sdp: string;
}

export interface IceCandidateMessage {
	type: "ice-candidate";
	candidate: {
		candidate: string;
		sdpMLineIndex: number;
		sdpMid: string;
		usernameFragment?: string;
	} | null;
}

export interface PromptMessage {
	type: "prompt";
	prompt: string;
	enhance_prompt?: boolean;
}

export interface SetImageMessage {
	type: "set_image";
	image_data: string | null;
	prompt?: string;
	enhance_prompt?: boolean;
}

export type IncomingMessage = OfferMessage | IceCandidateMessage | PromptMessage | SetImageMessage;

export interface AnswerMessage {
	type: "answer";
	sdp: string;
}

export interface SessionIdMessage {
	type: "session_id";
	session_id: string;
	server_ip: string;
	server_port: number;
}

export interface PromptAckMessage {
	type: "prompt_ack";
	prompt: string;
	success: boolean;
	error: string | null;
}

export interface SetImageAckMessage {
	type: "set_image_ack";
	success: boolean;
	error: string | null;
}

export interface GenerationStartedMessage {
	type: "generation_started";
}

export interface GenerationTickMessage {
	type: "generation_tick";
	seconds: number;
}

export type GenerationEndedReason =
	| "disconnect"
	| "timeout"
	| "moderation_violation"
	| "error"
	| "insufficient_credits";

export interface GenerationEndedMessage {
	type: "generation_ended";
	seconds: number;
	reason: GenerationEndedReason;
}

export interface ErrorMessage {
	type: "error";
	error: string;
}

export interface IceRestartMessage {
	type: "ice-restart";
	turn_config: {
		username: string;
		credential: string;
		server_url: string;
	};
}

export type OutgoingMessage =
	| AnswerMessage
	| IceCandidateMessage
	| SessionIdMessage
	| PromptAckMessage
	| SetImageAckMessage
	| GenerationStartedMessage
	| GenerationTickMessage
	| GenerationEndedMessage
	| ErrorMessage
	| IceRestartMessage;
