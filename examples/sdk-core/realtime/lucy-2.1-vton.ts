/**
 * Browser-only example - requires WebRTC APIs
 * Lucy 2.1 VTON (Virtual Try-On) for realtime garment/outfit transfer
 * See examples/nextjs-realtime or examples/react-vite for runnable demos
 */

import { createDecartClient, models } from "@decartai/sdk";

async function main() {
  const model = models.realtime("lucy-2.1-vton");

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: true,
    video: {
      frameRate: model.fps,
      width: model.width,
      height: model.height,
    },
  });

  const client = createDecartClient({
    apiKey: process.env.DECART_API_KEY!,
  });

  const realtimeClient = await client.realtime.connect(stream, {
    model,
    onRemoteStream: (editedStream) => {
      const video = document.getElementById("output") as HTMLVideoElement;
      video.srcObject = editedStream;
    },
    initialState: {
      prompt: {
        text: "Wearing a red leather jacket",
        enhance: true,
      },
    },
  });

  // Use a reference image of a garment to try on
  await realtimeClient.set({
    prompt: "Wearing the outfit from the reference image",
    image: "https://example.com/outfit-reference.png",
  });

  console.log("Session ID:", realtimeClient.sessionId);
}

main();
