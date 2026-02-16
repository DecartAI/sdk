/**
 * Browser-only example - requires WebRTC APIs
 * See examples/nextjs-realtime or examples/react-vite for runnable demos
 */

import { createDecartClient, models } from "@decartai/sdk";

/**
 * Example 1: Using playAudio() to inject audio
 * Pass null for stream - the SDK creates an internal audio stream
 */
async function withPlayAudio() {
  const model = models.realtime("live_avatar");

  const client = createDecartClient({
    apiKey: process.env.DECART_API_KEY!,
  });

  const realtimeClient = await client.realtime.connect(null, {
    model,
    onRemoteStream: (videoStream) => {
      const video = document.getElementById("output") as HTMLVideoElement;
      video.srcObject = videoStream;
    },
    initialState: {
      image: "https://example.com/avatar.png", // or File/Blob
      prompt: { text: "A friendly assistant", enhance: true },
    },
  });

  console.log("Session ID:", realtimeClient.sessionId);

  // Play audio through the avatar
  const audioFile = await fetch("/speech.mp3").then((r) => r.blob());
  await realtimeClient.playAudio?.(audioFile);

  // Cleanup
  realtimeClient.disconnect();
}

/**
 * Example 2: Using mic input directly
 * Pass user's audio stream - avatar speaks what user says
 */
async function withMicInput() {
  const model = models.realtime("live_avatar");

  // Get user's microphone stream
  const micStream = await navigator.mediaDevices.getUserMedia({
    audio: true,
    video: false,
  });

  const client = createDecartClient({
    apiKey: process.env.DECART_API_KEY!,
  });

  const realtimeClient = await client.realtime.connect(micStream, {
    model,
    onRemoteStream: (videoStream) => {
      const video = document.getElementById("output") as HTMLVideoElement;
      video.srcObject = videoStream;
    },
    initialState: {
      image: "https://example.com/avatar.png",
      prompt: { text: "A friendly assistant", enhance: true },
    },
  });

  console.log("Session ID:", realtimeClient.sessionId);
  // Avatar now speaks whatever the user says into the mic

  // Cleanup
  realtimeClient.disconnect();
}

// Run one of the examples
withPlayAudio();
// withMicInput();
