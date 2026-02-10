# TanStack Start Streamer Example

A [TanStack Start](https://tanstack.com/start) application demonstrating the producer + subscriber realtime pattern with the Decart SDK.

## Setup

1. Copy `.env.example` to `.env` and add your API key:

```sh
cp .env.example .env
```

2. Install dependencies & build:

```sh
pnpm install
pnpm build
```

3. Start the development server:

```sh
pnpm dev
```

4. Open [http://localhost:3000](http://localhost:3000) in your browser.

## Features

- Real-time webcam video transformation using `lucy_2_rt`
- Producer + subscriber streaming pattern
- Shareable viewer link via subscribe token
- Dynamic style prompt updates
- Connection state management
- Error handling

## Routes

| Route | Description |
|-------|-------------|
| `/` | **Producer** — streams your camera through `lucy_2_rt`, shows styled output, and generates a shareable viewer link |
| `/watch?token=...` | **Subscriber** — watches the producer's styled stream (receive-only, no camera needed) |

## How it works

1. The **server function** (`src/server/token.ts`) creates a short-lived client token via `client.tokens.create()` so the API key never leaves the server
2. The **producer** page captures the webcam and connects with `client.realtime.connect()`
3. Once connected, `realtimeClient.subscribeToken` is exposed as a shareable URL
4. The **subscriber** page receives the token via URL search params and calls `client.realtime.subscribe()` to view the same stream
5. The producer can update the style prompt in real-time with `realtimeClient.setPrompt()`

## Models

This example uses `lucy_2_rt` for video editing with reference image support. You can also use:

- `mirage` - MirageLSD video restyling model (older)
- `mirage_v2` - MirageLSD v2 for style transformation
- `lucy_v2v_720p_rt` - Lucy for video editing (add objects, change elements)
