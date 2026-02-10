# TanStack Streamer

A minimal [TanStack Start](https://tanstack.com/start) app demonstrating the **producer + subscriber** realtime pattern with the Decart SDK.

- **`/`** — Producer: streams your camera through `lucy_2_rt`, shows styled output, and generates a shareable viewer link
- **`/watch?token=...`** — Subscriber: watches the producer's styled stream (receive-only, no camera needed)

## Setup

```bash
cp .env.example .env     # add your DECART_API_KEY
pnpm install
pnpm dev                 # http://localhost:3000
```

## How it works

1. The **server function** (`src/server/token.ts`) creates a short-lived client token so the API key never leaves the server.
2. The **producer** page connects with `client.realtime.connect()` and exposes `realtimeClient.subscribeToken` once the session is established.
3. The **subscriber** page receives the token via URL search params and calls `client.realtime.subscribe()` to view the same stream.
