import mitt from "mitt";
import { z } from "zod";
import { createWebrtcError, type DecartSDKError } from "../utils/errors";
import type { SessionInfo } from "./types";
import { WebRTCConnection } from "./webrtc-connection";

export type RealTimeSubscribeClientOptions = {
  baseUrl: string;
  apiKey: string;
  integration?: string;
};

type OnRemoteStreamFn = (stream: MediaStream) => void;

const sessionInfoSchema = z.object({
  sessionId: z.string(),
  serverIp: z.string(),
  serverPort: z.number(),
}) satisfies z.ZodType<SessionInfo>;

const realTimeSubscribeConnectOptionsSchema = z.object({
  sessionInfo: sessionInfoSchema,
  onRemoteStream: z.custom<OnRemoteStreamFn>((val) => typeof val === "function", {
    message: "onRemoteStream must be a function",
  }),
});

export type RealTimeSubscribeConnectOptions = z.infer<typeof realTimeSubscribeConnectOptionsSchema>;

export type SubscribeEvents = {
  connectionChange: "connected" | "connecting" | "disconnected";
  error: DecartSDKError;
};

export type RealTimeSubscribeClient = {
  isConnected: () => boolean;
  getConnectionState: () => "connected" | "connecting" | "disconnected";
  disconnect: () => void;
  on: <K extends keyof SubscribeEvents>(event: K, listener: (data: SubscribeEvents[K]) => void) => void;
  off: <K extends keyof SubscribeEvents>(event: K, listener: (data: SubscribeEvents[K]) => void) => void;
  sessionId: string;
};

export const createRealTimeSubscribeClient = (opts: RealTimeSubscribeClientOptions) => {
  const { baseUrl, apiKey, integration } = opts;

  const connect = async (options: RealTimeSubscribeConnectOptions): Promise<RealTimeSubscribeClient> => {
    const eventEmitter = mitt<SubscribeEvents>();

    const parsedOptions = realTimeSubscribeConnectOptionsSchema.safeParse(options);
    if (!parsedOptions.success) {
      throw parsedOptions.error;
    }

    const { sessionInfo, onRemoteStream } = parsedOptions.data;
    const { sessionId, serverIp, serverPort } = sessionInfo;

    // Build the subscribe URL
    const subscribeUrl = `${baseUrl}/subscribe/${sessionId}?IP=${serverIp}&port=${serverPort}&api_key=${apiKey}`;

    const connection = new WebRTCConnection({
      onRemoteStream,
      onStateChange: (state: "connected" | "connecting" | "disconnected") => {
        eventEmitter.emit("connectionChange", state);
      },
      onError: (error) => {
        console.error("WebRTC subscribe error:", error);
        eventEmitter.emit("error", createWebrtcError(error));
      },
    });

    // Connect with null localStream for receive-only mode
    await connection.connect(subscribeUrl, null, 60000, integration);

    const client: RealTimeSubscribeClient = {
      isConnected: () => connection.state === "connected",
      getConnectionState: () => connection.state,
      disconnect: () => {
        connection.cleanup();
      },
      on: eventEmitter.on,
      off: eventEmitter.off,
      sessionId,
    };

    return client;
  };

  return {
    connect,
  };
};
