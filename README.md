# Mirage SDK

A JavaScript SDK for Mirage - Decart's realtime video-to-video AI model. Transform video streams in real-time with text prompts.

## Installation

```bash
npm install @decartai/mirage
# or
pnpm add @decartai/mirage
# or
yarn add @decartai/mirage
```

## Quick Start

```typescript
import { createMirageClient } from "@decartai/mirage";

// Get user's camera stream
const stream = await navigator.mediaDevices.getUserMedia({
  audio: true,
  video: { frameRate: 14 }
});

// Create a client
const client = createMirageClient({
  apiKey: "your-api-key-here"
});

// Connect and transform the video stream
const mirage = await client.realtime.connect(stream, {
  onRemoteStream: (transformedStream) => {
    // Display the transformed video in your app
    videoElement.srcObject = transformedStream;
  },
  initialState: {
    prompt: {
      text: "Anime",
      enrich: true // Mirage will enhance your prompt for better results
    }
  }
});

// Change the style on the fly
mirage.setPrompt("Cyberpunk city");

// Disconnect when done
mirage.disconnect();
```

## Features

- **Real-time video transformation** - Transform video streams with minimal latency using WebRTC
- **Dynamic prompt switching** - Change styles on the fly without reconnecting
- **Automatic prompt enhancement** - Mirage enriches simple prompts for better results
- **Mirror mode** - Built-in support for front-facing camera scenarios
- **Connection state management** - Monitor and react to connection changes
- **TypeScript support** - Full type definitions included

## Usage Guide

### 1. Creating a Client

```typescript
const client = createMirageClient({
  apiKey: "your-api-key-here",
  baseUrl: "wss://custom-endpoint.com" // optional, uses default Mirage endpoint
});
```

### 2. Connecting to the Real-time API

```typescript
const mirage = await client.realtime.connect(stream, {
  onRemoteStream: (stream: MediaStream) => {
    // Handle the transformed video stream
    videoElement.srcObject = stream;
  },
  initialState: {
    prompt: {
      text: "Lego World",
      enrich: true // Let Mirage enhance the prompt (recommended)
    },
    mirror: false // Set to true for front-facing cameras
  }
});
```

### 3. Managing Prompts

```typescript
// Simple prompt with automatic enhancement
mirage.setPrompt("Anime style");

// Use your own detailed prompt without enhancement
mirage.setPrompt(
  "A detailed artistic style with specific colors and mood...",
  { enrich: false }
);

// Get an enhanced prompt without applying it (for preview/debugging)
const enhanced = await mirage.enrichPrompt("Pixel art");
console.log(enhanced);
mirage.setPrompt(enhanced, { enrich: false });
```

### 4. Camera Mirroring

```typescript
// Toggle mirror mode (useful for front-facing cameras)
mirage.setMirror(true);
```

### 5. Connection State Management

```typescript
// Check connection state synchronously
const isConnected = mirage.isConnected();
const state = mirage.getConnectionState(); // "connected" | "connecting" | "disconnected"

// Listen to connection changes
mirage.on("connectionChange", (state) => {
  console.log(`Connection state: ${state}`);
  if (state === "disconnected") {
    // Handle disconnection
  }
});
```

### 6. Error Handling

```typescript
import type { MirageSDKError } from "@decartai/mirage";

mirage.on("error", (error: MirageSDKError) => {
  console.error("Mirage error:", error.code, error.message);
  
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

### 7. Cleanup

```typescript
// Always disconnect when done
mirage.disconnect();

// Remove event listeners
mirage.off("connectionChange", onConnectionChange);
mirage.off("error", onError);
```

## Complete Example

```typescript
import { createMirageClient, type MirageSDKError } from "@decartai/mirage";

async function setupMirage() {
  try {
    // Get camera stream
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: { frameRate: 14 }
    });

    // Create client
    const client = createMirageClient({
      apiKey: process.env.MIRAGE_API_KEY
    });

    // Connect with initial prompt
    const mirage = await client.realtime.connect(stream, {
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
    mirage.on("connectionChange", (state) => {
      updateUIConnectionStatus(state);
    });

    mirage.on("error", (error) => {
      console.error("Mirage error:", error);
      showErrorToUser(error.message);
    });

    // Allow user to change styles
    document.getElementById("style-input").addEventListener("change", async (e) => {
      mirage.setPrompt(e.target.value);
    });

    // Cleanup on page unload
    window.addEventListener("beforeunload", async () => {
      mirage.disconnect();
    });

    return mirage;
  } catch (error) {
    console.error("Failed to setup Mirage:", error);
  }
}

setupMirage();
```

## API Reference

### `createMirageClient(options)`
Creates a new Mirage client instance.

- `options.apiKey` (required) - Your Mirage API key
- `options.baseUrl` (optional) - Custom WebSocket endpoint

### `client.realtime.connect(stream, options)`
Connects to the real-time transformation service.

- `stream` - MediaStream from getUserMedia
- `options.onRemoteStream` - Callback for transformed video stream
- `options.initialState.prompt` - Initial transformation prompt
- `options.initialState.mirror` - Enable mirror mode

### `mirage.setPrompt(prompt, options?)`
Changes the transformation style.

- `prompt` - Text description of desired style
- `options.enrich` - Whether to enhance the prompt (default: true)

### `mirage.enrichPrompt(prompt)`
Gets an enhanced version of your prompt without applying it.

### `mirage.setMirror(enabled)`
Toggles video mirroring.

### `mirage.disconnect()`
Closes the connection and cleans up resources.

### Event: `'connectionChange'`
Fired when connection state changes.

### Event: `'error'`
Fired when an error occurs.

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
