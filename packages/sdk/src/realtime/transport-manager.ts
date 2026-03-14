import type { Emitter } from "mitt";
import type { ConnectionState, OutgoingMessage, WsMessageEvents } from "./types";

export interface RealtimeTransportManager {
  connect(localStream: MediaStream | null): Promise<boolean>;
  sendMessage(message: OutgoingMessage): boolean;
  setImage(imageBase64: string | null, options?: { prompt?: string; enhance?: boolean; timeout?: number }): Promise<void>;
  cleanup(): void;
  isConnected(): boolean;
  getConnectionState(): ConnectionState;
  getWebsocketMessageEmitter(): Emitter<WsMessageEvents>;
}
