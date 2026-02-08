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

  // setPrompt() to update the prompt
  const promptInput = document.getElementById("prompt") as HTMLInputElement;
  promptInput.addEventListener("input", () => {
    realtimeClient.setPrompt(promptInput.value);
  });

  // Skip server-side prompt enhancement
  await realtimeClient.setPrompt("A very detailed and specific prompt that is already well-crafted", {
    enhance: false,
  });

  // setPrompt() returns a promise that resolves on server acknowledgment
  await realtimeClient.setPrompt("cyberpunk city");
  console.log("Prompt updated and acknowledged");

  // set() replaces full state — use when updating both prompt and image atomically
  await realtimeClient.set({ prompt: "cyberpunk city", image: "base64string" });
}

main();
