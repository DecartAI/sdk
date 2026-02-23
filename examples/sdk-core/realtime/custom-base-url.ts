/**
 * Browser-only example - requires WebRTC APIs
 * Demonstrates using a custom realtimeBaseUrl for WebSocket connections
 * See examples/nextjs-realtime or examples/react-vite for runnable demos
 */

import { createDecartClient, models } from "@decartai/sdk";

async function main() {
  const model = models.realtime("mirage_v2");

  // Get webcam stream with model-specific settings
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: true,
    video: {
      frameRate: model.fps,
      width: model.width,
      height: model.height,
    },
  });

  // Create a client with a custom realtime WebSocket base URL
  // This overrides the default wss://api3.decart.ai endpoint
  const client = createDecartClient({
    apiKey: process.env.DECART_API_KEY!,
    realtimeBaseUrl: "wss://custom-ws.example.com",
  });

  const realtimeClient = await client.realtime.connect(stream, {
    model,
    onRemoteStream: (transformedStream) => {
      const video = document.getElementById("output") as HTMLVideoElement;
      video.srcObject = transformedStream;
    },
    initialState: {
      prompt: {
        text: "Studio Ghibli animation style",
        enhance: true,
      },
    },
  });

  console.log("Session ID:", realtimeClient.sessionId);
  console.log("Connected:", realtimeClient.isConnected());
}

main();
