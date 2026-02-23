# ws-signaling-proxy

Reference implementation of a WebSocket signaling proxy for Decart's realtime models. Sits between end-user clients and Decart's API, forwarding all signaling messages (SDP offers/answers, ICE candidates, prompts, etc.) while keeping your API key server-side.

WebRTC media flows directly between the client and Decart — the proxy only handles the control plane.

```
               signaling                   signaling
  Client  <----WebSocket---->  Proxy  <----WebSocket---->  Decart
                                 |
  Client  <----------------WebRTC (direct)-------------->  Decart
                            audio/video
```

## Quick start

```bash
cp .env.example .env   # add your DECART_API_KEY
pnpm install
pnpm dev               # starts proxy on ws://localhost:8080
```

Clients connect to:

```
ws://localhost:8080/v1/stream?model=lucy_2_rt
```

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `DECART_API_KEY` | Yes | — | Your Decart API key |
| `DECART_BASE_URL` | No | `wss://api3.decart.ai` | Decart WebSocket endpoint |
| `PORT` | No | `8080` | Proxy listen port |

## Scripts

| Command | Description |
|---|---|
| `pnpm dev` | Start with hot reload |
| `pnpm build` | Compile TypeScript to `dist/` |
| `pnpm start` | Run compiled output |
| `pnpm test:e2e` | Run e2e test (requires `DECART_API_KEY`) |

## How it works

Each client WebSocket connection creates a `ProxySession` that:

1. Opens an upstream connection to Decart with the server's API key
2. Forwards all messages bidirectionally
3. Buffers client messages until the upstream connection is ready
4. Propagates close events in both directions

The proxy does not inspect or modify message contents — it's a transparent pipe with structured logging.
