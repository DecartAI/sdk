/**
 * Browser-only example - requires WebRTC APIs
 * Lucy 2 for realtime video editing with reference image + prompt support
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

  // set() sends prompt + image atomically in a single message
  await realtimeClient.set({
    prompt: "A person wearing a superhero costume",
    enhance: true,
    image: "https://example.com/superhero-reference.png",
  });

  // set() also supports prompt-only updates
  await realtimeClient.set({ prompt: "Add sunglasses to the person" });

  // Accepts File, Blob, base64 string, or URL
  const fileInput = document.getElementById("image-upload") as HTMLInputElement;
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (file) {
      await realtimeClient.set({ image: file });
    }
  });

  // setPrompt() as syntactic sugar for set() with prompt only
  realtimeClient.setPrompt("Change the person's shirt to red");

  console.log("Session ID:", realtimeClient.sessionId);
}

main();
