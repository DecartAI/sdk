/**
 * Browser-only example - requires WebRTC APIs
 * Lucy 2 for realtime video editing with reference image support (better quality)
 * See examples/nextjs-realtime or examples/react-vite for runnable demos
 */

import { createDecartClient, models } from "@decartai/sdk";

async function main() {
  const model = models.realtime("lucy_2_rt");

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
        text: "Add a small dog in the background",
        enhance: true,
      },
    },
  });

  // Apply different edits
  realtimeClient.setPrompt("Change the person's shirt to red");
  realtimeClient.setPrompt("Add sunglasses to the person");

  console.log("Session ID:", realtimeClient.sessionId);
}

main();
