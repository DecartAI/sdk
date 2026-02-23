import { createServer } from "node:http";
import { type WebSocket, WebSocketServer } from "ws";
import { ProxySession } from "./proxy-session.js";

const DECART_API_KEY = process.env.DECART_API_KEY;
const DECART_BASE_URL = process.env.DECART_BASE_URL ?? "wss://api3.decart.ai";
const PORT = Number(process.env.PORT ?? 8080);

if (!DECART_API_KEY) {
  console.error("DECART_API_KEY is required");
  process.exit(1);
}

const server = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("ws-signaling-proxy");
});

const wss = new WebSocketServer({ server });

wss.on("connection", (clientWs: WebSocket, req) => {
  // Accept Decart-style URLs: /v1/stream?api_key=...&model=lucy_2_rt
  // The proxy ignores api_key from the client and uses its own.
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const model = url.searchParams.get("model") ?? "lucy_2_rt";

  console.log(`[proxy] client connected from ${req.url} (model=${model})`);

  const session = new ProxySession(clientWs, {
    decartApiKey: DECART_API_KEY,
    model,
    decartBaseUrl: DECART_BASE_URL,
  });

  session.start();
});

server.listen(PORT, () => {
  console.log(`[proxy] listening on ws://localhost:${PORT}`);
  console.log(`[proxy] connect with: ws://localhost:${PORT}/?model=lucy_2_rt`);
});

const shutdown = () => {
  console.log("\n[proxy] shutting down...");
  for (const client of wss.clients) {
    client.close(1001, "server shutting down");
  }
  server.close(() => process.exit(0));
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
