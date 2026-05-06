import type { DecartSDKError } from "../utils/errors";
import type { DiagnosticEvent } from "./diagnostics";
import type { ConnectionChangeDetails, ConnectionState, QueuePosition } from "./types";

type TokenPayload = {
  room_name: string;
};

export function encodeSubscribeToken(roomName: string): string {
  return btoa(JSON.stringify({ room_name: roomName }));
}

export function decodeSubscribeToken(token: string): TokenPayload {
  try {
    const payload = JSON.parse(atob(token)) as Partial<TokenPayload>;
    if (!payload.room_name || typeof payload.room_name !== "string") {
      throw new Error("Invalid subscribe token format");
    }
    return { room_name: payload.room_name };
  } catch {
    throw new Error("Invalid subscribe token");
  }
}

export type SubscribeEvents = {
  connectionChange: ConnectionState;
  pending: QueuePosition;
  queuePosition: QueuePosition;
  error: DecartSDKError;
  diagnostic: DiagnosticEvent;
};

export type RealTimeSubscribeClient = {
  isConnected: () => boolean;
  getConnectionState: () => ConnectionState;
  disconnect: () => void;
  on: <K extends keyof SubscribeEvents>(event: K, listener: (data: SubscribeEvents[K]) => void) => void;
  off: <K extends keyof SubscribeEvents>(event: K, listener: (data: SubscribeEvents[K]) => void) => void;
};

export type SubscribeOptions = {
  token: string;
  onRemoteStream: (stream: MediaStream) => void;
  onConnectionChange?: (state: ConnectionState, details?: ConnectionChangeDetails) => void;
  onQueuePosition?: (queuePosition: QueuePosition) => void;
};
