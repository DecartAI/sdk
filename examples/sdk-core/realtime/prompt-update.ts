/**
 * Browser-only example - requires WebRTC APIs
 * Demonstrates updating prompts dynamically
 * See examples/nextjs-realtime or examples/react-vite for runnable demos
 */

import { createDecartClient, models } from "@decartai/sdk";

async function main() {
  const model = models.realtime("mirage_v2");

  const stream = await navigator.mediaDevices.getUserMedia({
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
    onRemoteStream: (transformedStream) => {
      const video = document.getElementById("output") as HTMLVideoElement;
      video.srcObject = transformedStream;
    },
    initialState: {
      prompt: { text: "oil painting style", enhance: true },
    },
  });

  // Use set() to update prompt from UI input
  const promptInput = document.getElementById("prompt") as HTMLInputElement;
  promptInput.addEventListener("input", () => {
    realtimeClient.set({ prompt: promptInput.value });
  });

  // Skip server-side prompt enhancement
  await realtimeClient.set({
    prompt: "A very detailed and specific prompt that is already well-crafted",
    enhance: false,
  });

  // set() returns a promise that resolves on server acknowledgment
  await realtimeClient.set({ prompt: "cyberpunk city" });
  console.log("Prompt updated and acknowledged");

  // setPrompt() still works for backward compatibility
  realtimeClient.setPrompt("oil painting style");
}

main();
