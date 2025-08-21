# Decart SDK

A JavaScript SDK for Decart's models.

## Installation

```bash
npm install @decartai/sdk
# or
pnpm add @decartai/sdk
# or
yarn add @decartai/sdk
```

## Quick Start

### Real-time Video Transformation

```typescript
import { createDecartClient, models } from "@decartai/sdk";

const model = models.v2v("decart-v2v-v2.0-704p");

// Get user's camera stream
const stream = await navigator.mediaDevices.getUserMedia({
  audio: true,
  video: { 
		frameRate: model.fps,
		width: model.width,
		height: model.height,
  }
});

// Create a client
const client = createDecartClient({
  apiKey: "your-api-key-here"
});

// Connect and transform the video stream
const realtimeClient = await client.realtime.connect(stream, {
  model,
  onRemoteStream: (transformedStream) => {
    // Display the transformed video in your app
    videoElement.srcObject = transformedStream;
  },
  initialState: {
    prompt: {
      text: "Anime",
      enrich: true // We will enhance your prompt for better results
    }
  }
});

// Change the style on the fly
realtimeClient.setPrompt("Cyberpunk city");

// Disconnect when done
realtimeClient.disconnect();
```

### Process Video Files

```typescript
import { createDecartClient } from "@decartai/sdk";

// Create a client
const client = createDecartClient({
  apiKey: "your-api-key-here"
});

// Process a local video file
const fileInput = document.querySelector('input[type="file"]');
const file = fileInput.files[0];

const result = await client.process.video(file, {
  model: models.v2v("decart-v2v-v2.0-704p"),
  prompt: {
    text: "Lego World",
    enrich: true
  },
  mirror: false
});

// Display the processed video
const video = document.querySelector('video');
video.src = URL.createObjectURL(result);

// Process a video from URL
const urlResult = await client.process.video(
  "https://example.com/video.mp4",
  {
    model: models.v2v("decart-v2v-v2.0-704p"),
    prompt: {
      text: "Anime style"
    }
  }
);
```

## Features

- **Real-time video transformation** - Transform video streams with minimal latency using WebRTC
- **Video file processing** - Transform video files and URLs on-demand
- **Dynamic prompt switching** - Change styles on the fly without reconnecting
- **Automatic prompt enhancement** - Decart enriches simple prompts for better results
- **Mirror mode** - Built-in support for front-facing camera scenarios
- **Connection state management** - Monitor and react to connection changes
- **TypeScript support** - Full type definitions included

## Usage Guide

### Real-time API

#### 1. Creating a Client

```typescript
const client = createDecartClient({
  apiKey: "your-api-key-here",
  baseUrl: "https://custom-endpoint.com" // optional, uses default Decart endpoint
});
```

#### 2. Connecting to the Real-time API

```typescript
const realtimeClient = await client.realtime.connect(stream, {
  model: models.v2v("decart-v2v-v2.0-704p"),
  onRemoteStream: (stream: MediaStream) => {
    // Handle the transformed video stream
    videoElement.srcObject = stream;
  },
  initialState: {
    prompt: {
      text: "Lego World",
      enrich: true // Let Decart enhance the prompt (recommended)
    },
    mirror: false // Set to true for front-facing cameras
  }
});
```

#### 3. Managing Prompts

```typescript
// Simple prompt with automatic enhancement
realtimeClient.setPrompt("Anime style");

// Use your own detailed prompt without enhancement
realtimeClient.setPrompt(
  "A detailed artistic style with specific colors and mood...",
  { enrich: false }
);

// Get an enhanced prompt without applying it (for preview/debugging)
const enhanced = await realtimeClient.enrichPrompt("Pixel art");
console.log(enhanced);
realtimeClient.setPrompt(enhanced, { enrich: false });
```

#### 4. Camera Mirroring

```typescript
// Toggle mirror mode (useful for front-facing cameras)
realtimeClient.setMirror(true);
```

#### 5. Connection State Management

```typescript
// Check connection state synchronously
const isConnected = realtimeClient.isConnected();
const state = realtimeClient.getConnectionState(); // "connected" | "connecting" | "disconnected"

// Listen to connection changes
realtimeClient.on("connectionChange", (state) => {
  console.log(`Connection state: ${state}`);
  if (state === "disconnected") {
    // Handle disconnection
  }
});
```

#### 6. Error Handling

```typescript
import type { DecartSDKError } from "@decartai/sdk";

realtimeClient.on("error", (error: DecartSDKError) => {
  console.error("SDK error:", error.code, error.message);
  
  // Handle specific errors
  switch(error.code) {
    case "INVALID_API_KEY":
      // Handle invalid API key
      break;
    case "WEB_RTC_ERROR":
      // Handle WebRTC connection issues
      break;
  }
});
```

#### 7. Cleanup

```typescript
// Always disconnect when done
realtimeClient.disconnect();

// Remove event listeners
realtimeClient.off("connectionChange", onConnectionChange);
realtimeClient.off("error", onError);
```

### Complete Example

```typescript
import { createDecartClient, type DecartSDKError } from "@decartai/sdk";

async function setupSDK() {
  try {
    // Get camera stream
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: { frameRate: 14 }
    });

    // Create client
    const client = createDecartClient({
      apiKey: process.env.MIRAGE_API_KEY
    });

    // Connect with initial prompt
    const realtimeClient = await client.realtime.connect(stream, {
      onRemoteStream: (stream) => {
        const video = document.getElementById("output-video");
        video.srcObject = stream;
      },
      initialState: {
        prompt: {
          text: "Studio Ghibli animation style",
          enrich: true
        },
        mirror: true // Using front camera
      }
    });

    // Set up event handlers
    realtimeClient.on("connectionChange", (state) => {
      updateUIConnectionStatus(state);
    });

    realtimeClient.on("error", (error) => {
      console.error("SDK error:", error);
      showErrorToUser(error.message);
    });

    // Allow user to change styles
    document.getElementById("style-input").addEventListener("change", async (e) => {
      realtimeClient.setPrompt(e.target.value);
    });

    // Cleanup on page unload
    window.addEventListener("beforeunload", async () => {
      realtimeClient.disconnect();
    });

    return realtimeClient;
  } catch (error) {
    console.error("Failed to setup DecartSDK:", error);
  }
}

setupSDK();
```

## Process API

#### 1. Creating a Client

```typescript
const client = createDecartClient({
  apiKey: "your-api-key-here",
  baseUrl: "https://custom-endpoint.com" // optional, uses default Decart endpoint
});
```

#### 2. Process Video Files

```typescript
// 1. Process a local file (browser)
const fileInput = document.querySelector('input[type="file"]');
const file = fileInput.files[0];

const result = await client.process.video(file, {
  prompt: {
    text: "Cartoon style",
    enrich: true
  },
  mirror: false
});

// Use the processed video
const video = document.querySelector('video');
video.src = URL.createObjectURL(result);

// 3. With cancellation
const controller = new AbortController();
const result = await client.process.video(file, {
  prompt: { text: "Watercolor painting" },
  signal: controller.signal
});

// Cancel if needed
controller.abort();
```

## API Reference

### `createDecartClient(options)`
Creates a new Decart client instance.

- `options.apiKey` (required) - Your Decart API key
- `options.baseUrl` (optional) - Custom API endpoint (defaults to Decart)

### Real-time API

#### `client.realtime.connect(stream, options)`
Connects to the real-time transformation service.

- `stream` - MediaStream from getUserMedia
- `options.onRemoteStream` - Callback for transformed video stream
- `options.initialState.prompt` - Initial transformation prompt
- `options.initialState.mirror` - Enable mirror mode

#### `realtimeClient.setPrompt(prompt, options?)`
Changes the transformation style.

- `prompt` - Text description of desired style
- `options.enrich` - Whether to enhance the prompt (default: true)

#### `realtimeClient.enrichPrompt(prompt)`
Gets an enhanced version of your prompt without applying it.

#### `realtimeClient.setMirror(enabled)`
Toggles video mirroring.

#### `realtimeClient.sessionId`
The id of the current real-time inference session.

#### `realtimeClient.disconnect()`
Closes the connection and cleans up resources.

#### Event: `'connectionChange'`
Fired when connection state changes.

#### Event: `'error'`
Fired when an error occurs.

### Process API

#### `client.process.video(input, options?)`
Process a video file or URL.

**Parameters:**
- `input: VideoInput` - Video input, can be:
  - `File` - File object from input element (browser)
  - `Blob` - Binary data (browser)
  - `ReadableStream` - Streaming input
  - `URL` or `string` - HTTP/HTTPS URL to video

- `options?: ProcessOptions` - Optional configuration:
  - `prompt?: { text: string; enrich?: boolean }` - Style transformation
    - `text` - Style description (required if prompt is provided)
    - `enrich` - Enable prompt enhancement (default: `true`)
  - `mirror?: boolean` - Mirror the video horizontally (default: `false`)
  - `signal?: AbortSignal` - AbortSignal for cancellation

**Returns:** `Promise<Blob>` - The transformed video

**Type Definitions:**
```typescript
type VideoInput = File | Blob | ReadableStream | URL | string;

type ProcessOptions = {
  prompt?: {
    text: string;
    enrich?: boolean;
  };
  mirror?: boolean;
  signal?: AbortSignal;
};
```

## Development

### Install dependencies
```bash
pnpm install
```

### Run tests
```bash
pnpm test
```

### Build the library
```bash
pnpm build
```

### Run development mode
```bash
pnpm dev
```

### Run examples
```bash
pnpm dev:example
```

## License

MIT
