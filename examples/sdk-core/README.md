# Decart SDK Core

Quick, runnable examples demonstrating core SDK functionality.

## Setup

1. Copy `.env.example` to `.env` and add your API key:

```sh
cp .env.example .env
```

2. From the repo root:

```sh
pnpm install
pnpm build
```

3. Run any example:

```sh
cd examples/sdk-core
pnpm tsx video/video-to-video.ts
pnpm tsx image/image-to-image.ts
```

## Examples

### Image Generation

Image models use the synchronous Process API - they return immediately with a Blob.

- `image/image-to-image.ts` - Transform existing image with a prompt (`lucy-image-2`)

### Video Generation

Video models use the asynchronous Queue API - jobs are submitted and polled for completion.

- `video/video-to-video.ts` - Transform existing video with a prompt (`lucy-clip`)
- `video/video-editing.ts` - Edit video with prompt, reference image, or both (`lucy-2`)
- `video/long-form-video-restyle.ts` - Transform existing video with `lucy-restyle-2`
- `video/manual-polling.ts` - Manual job status polling

### Realtime (Browser-only)

These examples require browser APIs (WebRTC) and are for reference.
See `examples/nextjs-realtime` or `examples/react-vite` for runnable demos.

- `realtime/mirage-basic.ts` - Basic Mirage connection (style transformation)
- `realtime/mirage-v2-basic.ts` - Mirage v2 connection (improved style transformation)
- `realtime/lucy-v2v-720p.ts` - Lucy v2v realtime (video editing - add objects, change elements)
- `realtime/lucy-2.ts` - Lucy 2 realtime (better quality video editing with reference image support)
- `realtime/live-avatar.ts` - Live avatar (audio-driven avatar with playAudio or mic input)
- `realtime/connection-events.ts` - Handling connection state and errors
- `realtime/prompt-update.ts` - Updating prompt dynamically
- `realtime/custom-model.ts` - Using a custom model definition (e.g., preview/experimental models)
- `realtime/custom-base-url.ts` - Using a custom WebSocket base URL for realtime connections

## API Reference

### Image Models (Process API)

```typescript
// Image-to-image (edit image with prompt)
const blob = await client.process({
  model: models.image("lucy-image-2"),
  prompt: "Transform to watercolor style",
  data: imageBlob,
});
```

### Video Models (Queue API)

```typescript
// Automatic polling (video-to-video)
const result = await client.queue.submitAndPoll({
  model: models.video("lucy-clip"),
  prompt: "Make it look like a watercolor painting",
  data: videoBlob,
  onStatusChange: (job) => console.log(job.status),
});

// Manual polling
const job = await client.queue.submit({ ... });
const status = await client.queue.status(job.job_id);
const blob = await client.queue.result(job.job_id);
```

### Realtime (WebRTC)

```typescript
const realtimeClient = await client.realtime.connect(stream, {
  model: models.realtime("lucy-restyle-2"),
  onRemoteStream: (transformedStream) => { ... },
  initialState: { prompt: { text: "anime style", enhance: true } },
});

realtimeClient.setPrompt("new style");
realtimeClient.on("connectionChange", (state) => { ... });
realtimeClient.disconnect();
```

### Live Avatar (WebRTC)

```typescript
// Option 1: Use playAudio() to inject audio
const realtimeClient = await client.realtime.connect(null, {
  model: models.realtime("live-avatar"),
  onRemoteStream: (videoStream) => { ... },
  initialState: {
    image: "https://example.com/avatar.png",
    prompt: { text: "A friendly assistant", enhance: true },
  },
});
await realtimeClient.playAudio(audioBlob);

// Option 2: Use mic input directly
const micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
const realtimeClient = await client.realtime.connect(micStream, {
  model: models.realtime("live-avatar"),
  onRemoteStream: (videoStream) => { ... },
  initialState: {
    image: avatarFile,
    prompt: { text: "A friendly assistant", enhance: true },
  },
});
```
