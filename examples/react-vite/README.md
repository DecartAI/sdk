# React + Vite Realtime Example

A React application with Vite demonstrating real-time video transformation with the Decart SDK.

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

4. Open [http://localhost:5173](http://localhost:5173) in your browser.

## Features

- Real-time webcam video transformation
- Dynamic style prompt updates
- Connection state management
- Error handling

## How it works

1. The app captures your webcam feed using `getUserMedia`
2. The video stream is sent to Decart's realtime API
3. The transformed video is displayed side-by-side with the original
4. You can change the style prompt in real-time

## Models

This example uses `mirage_v2` for style transformation. You can also use:

- `mirage` - MirageLSD video restyling model (older)
- `lucy_v2v_720p_rt` - Lucy for video editing (add objects, change elements)
