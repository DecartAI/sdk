import { classifyWebrtcError, type DecartSDKError } from "../utils/errors";
import { createConsoleLogger, type Logger } from "../utils/logger";
import { createEventBuffer } from "./event-buffer";
import type { DiagnosticEvent } from "./observability/diagnostics";
import { RealtimeObservability } from "./observability/realtime-observability";
import { StreamSession } from "./stream-session";
import type { ConnectionState, QueuePosition } from "./types";

type TokenPayload = {
  room_name: string;
};

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
  onConnectionChange?: (state: ConnectionState) => void;
  onQueuePosition?: (queuePosition: QueuePosition) => void;
};

export type RealTimeSubscribeClientOptions = {
  baseUrl: string;
  apiKey: string;
  integration?: string;
  logger: Logger;
};

export const createRealTimeSubscribeClient = (opts: RealTimeSubscribeClientOptions) => {
  const { baseUrl, apiKey, integration } = opts;
  const logger = opts.logger ?? createConsoleLogger("info");

  const subscribe = async (options: SubscribeOptions): Promise<RealTimeSubscribeClient> => {
    const { room_name: roomName } = decodeSubscribeToken(options.token);
    const subscribeUrl = `${baseUrl}/watch-stream/${encodeURIComponent(roomName)}?api_key=${encodeURIComponent(apiKey)}`;

    const { emitter, emitOrBuffer, flush, stop } = createEventBuffer<SubscribeEvents>();

    let session: StreamSession | undefined;
    let observability: RealtimeObservability | undefined;

    try {
      observability = new RealtimeObservability({
        telemetryEnabled: false,
        apiKey,
        integration,
        logger,
        onDiagnostic: (event) => emitOrBuffer("diagnostic", event),
      });

      session = new StreamSession({
        url: subscribeUrl,
        integration,
        observability,
        localStream: null,
      });

      session.on("remoteStream", options.onRemoteStream);

      session.on("connectionChange", (state) => {
        emitOrBuffer("connectionChange", state);
        options.onConnectionChange?.(state);
      });

      session.on("queuePosition", (qp) => {
        emitOrBuffer("queuePosition", qp);
        options.onQueuePosition?.(qp);
      });

      session.on("error", (error) => {
        logger.error("Realtime subscribe error", { error: error.message });
        emitOrBuffer("error", classifyWebrtcError(error));
      });

      const activeSession = session;
      await activeSession.connect();

      const client: RealTimeSubscribeClient = {
        isConnected: () => activeSession.isConnected(),
        getConnectionState: () => activeSession.getConnectionState(),
        disconnect: () => {
          observability?.stop();
          stop();
          activeSession.disconnect();
        },
        on: emitter.on,
        off: emitter.off,
      };

      flush();
      return client;
    } catch (error) {
      observability?.stop();
      session?.disconnect();
      throw error;
    }
  };

  return { subscribe };
};
