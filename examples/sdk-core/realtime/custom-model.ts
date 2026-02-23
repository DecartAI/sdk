/**
 * Custom Model Definition Example
 *
 * Demonstrates how to define and use a custom model that isn't
 * built into the SDK. This is useful for preview/experimental models
 * or private deployments.
 *
 * Browser-only example - requires WebRTC APIs
 * See examples/nextjs-realtime or examples/react-vite for runnable demos
 */

import { createDecartClient } from "@decartai/sdk";
import type { CustomModelDefinition } from "@decartai/sdk";

async function main() {
  // Define a custom model that isn't in the SDK's built-in registry.
  // This works for any model that conforms to the CustomModelDefinition shape.
  const lucy2RtPreview: CustomModelDefinition = {
    name: "lucy_2_rt_preview",
    urlPath: "/v1/stream",
    fps: 20,
    width: 1280,
    height: 720,
  };

  // Get webcam stream using the custom model's settings
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: true,
    video: {
      frameRate: lucy2RtPreview.fps,
      width: lucy2RtPreview.width,
      height: lucy2RtPreview.height,
    },
  });

  const client = createDecartClient({
    apiKey: process.env.DECART_API_KEY!,
  });

  // Pass the custom model directly to realtime.connect()
  const realtimeClient = await client.realtime.connect(stream, {
    model: lucy2RtPreview,
    onRemoteStream: (transformedStream) => {
      const video = document.getElementById("output") as HTMLVideoElement;
      video.srcObject = transformedStream;
    },
    initialState: {
      prompt: {
        text: "cinematic lighting, film grain",
        enhance: true,
      },
    },
  });

  console.log("Session ID:", realtimeClient.sessionId);
  console.log("Connected:", realtimeClient.isConnected());

  // Update prompt dynamically, same as built-in models
  realtimeClient.setPrompt("watercolor painting style");
}

main();
