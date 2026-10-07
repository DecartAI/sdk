# Next.js Realtime Example

A Next.js application demonstrating real-time video transformation with the Decart SDK.

## Setup

1. Copy `.env.example` to `.env.local` and add your API key:

```sh
cp .env.example .env.local
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

- Real-time webcam video transformation
- A fresh client token for every connect and reconnect (`apiKeyProvider`), minted on the server
- Dynamic style prompt updates
- Connection state display, including reconnects
- Error handling

## How it works

Client tokens expire **60 seconds** after minting by default, so a token fetched on page load is
usually dead by the time the user has granted the camera and pressed Start. Instead of holding a
token, the page hands the SDK a function that fetches one:

```ts
// components/video-stream.tsx
const client = createDecartClient({
  apiKeyProvider: async () => {
    const response = await fetch("/api/realtime-token", { method: "POST" });
    const { apiKey } = await response.json();
    return apiKey;
  },
});
```

1. Pressing **Start** captures the webcam and calls `client.realtime.connect(...)`.
2. The SDK calls `apiKeyProvider`, which `POST`s to `/api/realtime-token`.
3. The route mints a token with `client.tokens.create({ expiresIn: 60 })` using the permanent
   `DECART_API_KEY`, which never leaves the server.
4. The SDK dials with that token. If the session drops, the SDK reconnects and calls
   `apiKeyProvider` again, so a reconnect never reuses the token the session started with.
5. The transformed video is shown next to the original; the prompt can be changed live.

If you prefer a static `apiKey`, mint it right before `connect()`. The SDK reads the token's
`exp` before dialling and rejects an expired one with `TOKEN_EXPIRED` instead of opening a
socket.

## Models

This example uses `lucy-restyle-2` for style transformation. You can also use:

- `lucy-2.1` - Lucy 2.1 for video editing with reference image support
