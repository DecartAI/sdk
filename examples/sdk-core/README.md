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
pnpm tsx video/text-to-video.ts
pnpm tsx image/text-to-image.ts
```

## Examples

### Image Generation

Image models use the synchronous Process API - they return immediately with a Blob.

- `image/text-to-image.ts` - Generate image from text prompt
- `image/image-to-image.ts` - Transform existing image

### Video Generation

Video models use the asynchronous Queue API - jobs are submitted and polled for completion.

- `video/text-to-video.ts` - Generate video from text prompt
- `video/image-to-video.ts` - Generate video from image
- `video/video-to-video.ts` - Transform existing video
- `video/long-form-video-restyle.ts` - Transform existing video with `lucy-restyle-v2v`
- `video/first-last-frame.ts` - Generate video from first/last frames
- `video/manual-polling.ts` - Manual job status polling

### Realtime (Browser-only)

These examples require browser APIs (WebRTC) and are for reference.
See `examples/nextjs-realtime` or `examples/react-vite` for runnable demos.

- `realtime/mirage-basic.ts` - Basic Mirage connection (style transformation)
- `realtime/mirage-v2-basic.ts` - Mirage v2 connection (improved style transformation)
- `realtime/lucy-v2v-720p.ts` - Lucy v2v realtime (video editing - add objects, change elements)
- `realtime/live-avatar.ts` - Live avatar (audio-driven avatar with playAudio or mic input)
- `realtime/connection-events.ts` - Handling connection state and errors
- `realtime/prompt-update.ts` - Updating prompt dynamically

## API Reference

### Image Models (Process API)

```typescript
// Text-to-image
const blob = await client.process({
  model: models.image("lucy-pro-t2i"),
  prompt: "A beautiful sunset",
});

// Image-to-image
const blob = await client.process({
  model: models.image("lucy-pro-i2i"),
  prompt: "Transform to watercolor style",
  data: imageBlob,
});
```

### Video Models (Queue API)

```typescript
// Automatic polling
const result = await client.queue.submitAndPoll({
  model: models.video("lucy-pro-t2v"),
  prompt: "A cat playing piano",
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
  model: models.realtime("mirage_v2"),
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
  model: models.realtime("live_avatar"),
  onRemoteStream: (videoStream) => { ... },
  avatar: { avatarImage: "https://example.com/avatar.png" },
});
await realtimeClient.playAudio(audioBlob);

// Option 2: Use mic input directly
const micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
const realtimeClient = await client.realtime.connect(micStream, {
  model: models.realtime("live_avatar"),
  onRemoteStream: (videoStream) => { ... },
  avatar: { avatarImage: avatarFile },
});
```
