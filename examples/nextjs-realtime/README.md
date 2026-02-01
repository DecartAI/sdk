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
- Dynamic style prompt updates
- Connection state management
- Error handling

## How it works

1. The frontend requests a short-lived client token from `/api/realtime-token`
2. The backend uses `client.tokens.create()` to generate the token
3. The frontend uses the client token to connect to Decart's Realtime API
4. Webcam feed is captured and sent to Decart's realtime API
5. Transformed video is displayed side-by-side with the original
6. You can change the style prompt in real-time

## Models

This example uses `mirage_v2` for style transformation. You can also use:

- `mirage` - MirageLSD video restyling model (older)
- `lucy_v2v_720p_rt` - Lucy for video editing (add objects, change elements)
- `lucy_2_rt` - Lucy 2 for video editing with reference image support (better quality)
