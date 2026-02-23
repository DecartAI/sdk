import WebSocket from "ws";
import type { IncomingMessage, OutgoingMessage } from "./types.js";

export class ProxySession {
  private upstream: WebSocket | null = null;
  private _sessionId: string | null = null;
  private closed = false;
  private upstreamReady = false;
  private pendingMessages: { data: WebSocket.RawData; isBinary: boolean }[] = [];

  constructor(
    private clientWs: WebSocket,
    private config: {
      decartApiKey: string;
      model: string;
      decartBaseUrl: string;
    },
  ) {}

  get sessionId() {
    return this._sessionId;
  }

  start() {
    const url = `${this.config.decartBaseUrl}/v1/stream?api_key=${this.config.decartApiKey}&model=${this.config.model}`;
    this.upstream = new WebSocket(url);

    this.upstream.on("open", () => {
      console.log(`[proxy] upstream connected (model=${this.config.model})`);
      this.upstreamReady = true;
      for (const { data, isBinary } of this.pendingMessages) {
        this.upstream?.send(data, { binary: isBinary });
        this.logIncomingMessage(data);
      }
      this.pendingMessages = [];
    });

    this.upstream.on("error", (err) => {
      console.error(`[proxy] upstream error: ${err.message}`);
      this.close(1011, "upstream connection error");
    });

    // Client → Decart (buffer until upstream is open, preserve text/binary frame type)
    this.clientWs.on("message", (data, isBinary) => {
      if (this.upstreamReady && this.upstream?.readyState === WebSocket.OPEN) {
        this.upstream.send(data, { binary: isBinary });
        this.logIncomingMessage(data);
      } else {
        this.pendingMessages.push({ data, isBinary });
      }
    });

    // Decart → Client (preserve text/binary frame type)
    this.upstream.on("message", (data, isBinary) => {
      if (this.clientWs.readyState === WebSocket.OPEN) {
        this.clientWs.send(data, { binary: isBinary });
        this.logOutgoingMessage(data);
      }
    });

    // Close propagation
    this.clientWs.on("close", (code, reason) => {
      console.log(`[${this._sessionId ?? "?"}] client disconnected (code=${code})`);
      this.close(code, reason.toString());
    });

    this.upstream.on("close", (code, reason) => {
      const reasonStr = reason.toString();
      console.log(
        `[${this._sessionId ?? "?"}] upstream disconnected (code=${code}${reasonStr ? `, reason=${reasonStr}` : ""})`,
      );
      this.close(code, reasonStr);
    });
  }

  close(code?: number, reason?: string) {
    if (this.closed) return;
    this.closed = true;

    const safeCode = this.sanitizeCloseCode(code);
    if (this.upstream && this.upstream.readyState !== WebSocket.CLOSED) {
      this.upstream.close(safeCode, reason);
    }
    if (this.clientWs.readyState !== WebSocket.CLOSED) {
      this.clientWs.close(safeCode, reason);
    }
  }

  private sanitizeCloseCode(code?: number): number {
    if (code !== undefined && (code === 1000 || code >= 3000)) {
      return code;
    }
    return 1000;
  }

  private logIncomingMessage(data: WebSocket.RawData) {
    try {
      const msg = JSON.parse(data.toString()) as IncomingMessage;
      const id = this._sessionId ?? "?";
      switch (msg.type) {
        case "prompt":
          console.log(`[${id}] → prompt: ${msg.prompt.slice(0, 80)}`);
          break;
        case "set_image":
          console.log(`[${id}] → set_image (has_prompt=${Boolean(msg.prompt)})`);
          break;
        case "offer":
          console.log(`[${id}] → offer`);
          break;
        case "ice-candidate":
          break; // too noisy
      }
    } catch {
      // non-JSON — forwarded as-is
    }
  }

  private logOutgoingMessage(data: WebSocket.RawData) {
    try {
      const msg = JSON.parse(data.toString()) as OutgoingMessage;
      if (msg.type === "session_id") {
        this._sessionId = msg.session_id;
      }
      const id = this._sessionId ?? "?";
      switch (msg.type) {
        case "session_id":
          console.log(`[${id}] session started (server=${msg.server_ip}:${msg.server_port})`);
          break;
        case "prompt_ack":
          console.log(`[${id}] ← prompt_ack (success=${msg.success})`);
          break;
        case "set_image_ack":
          console.log(`[${id}] ← set_image_ack (success=${msg.success})`);
          break;
        case "generation_started":
          console.log(`[${id}] ← generation started`);
          break;
        case "generation_ended":
          console.log(`[${id}] ← ended: ${msg.reason} (${msg.seconds}s)`);
          break;
        case "error":
          console.error(`[${id}] ← error: ${msg.error}`);
          break;
        case "ice-restart":
          console.log(`[${id}] ← ice-restart`);
          break;
        case "answer":
          console.log(`[${id}] ← answer`);
          break;
        case "generation_tick":
        case "ice-candidate":
          break; // too noisy
      }
    } catch {
      // non-JSON — forwarded as-is
    }
  }
}
