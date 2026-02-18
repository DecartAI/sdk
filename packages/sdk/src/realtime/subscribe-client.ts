import type { DecartSDKError } from "../utils/errors";
import type { DiagnosticEvent } from "./diagnostics";
import type { ConnectionState } from "./types";

type TokenPayload = {
  sid: string;
  ip: string;
  port: number;
};

export function encodeSubscribeToken(sessionId: string, serverIp: string, serverPort: number): string {
  return btoa(JSON.stringify({ sid: sessionId, ip: serverIp, port: serverPort }));
}

export function decodeSubscribeToken(token: string): TokenPayload {
  try {
    const payload = JSON.parse(atob(token)) as TokenPayload;
    if (!payload.sid || !payload.ip || !payload.port) {
      throw new Error("Invalid subscribe token format");
    }
    return payload;
  } catch {
    throw new Error("Invalid subscribe token");
  }
}

export type SubscribeEvents = {
  connectionChange: ConnectionState;
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
};
