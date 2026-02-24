# Decart SDK

A JavaScript SDK for Decart's models.

## Installation

```bash
npm install @decartai/sdk
# or
pnpm add @decartai/sdk
# or
yarn add @decartai/sdk
```

## Documentation

For complete documentation, guides, and examples, visit:
**https://docs.platform.decart.ai/sdks/javascript**

## Quick Start

### Real-time Video Transformation

```typescript
import { createDecartClient, models } from "@decartai/sdk";

const model = models.realtime("mirage_v2");

// Get user's camera stream
const stream = await navigator.mediaDevices.getUserMedia({
  audio: true,
  video: { 
		frameRate: model.fps,
		width: model.width,
		height: model.height,
  }
});

// Create a client
const client = createDecartClient({
  apiKey: "your-api-key-here"
});

// Connect and transform the video stream
const realtimeClient = await client.realtime.connect(stream, {
  model,
  onRemoteStream: (transformedStream) => {
    videoElement.srcObject = transformedStream;
  },
  initialState: {
    prompt: {
      text: "Anime",
      enhance: true
    }
  }
});

// Change the style on the fly
realtimeClient.setPrompt("Cyberpunk city");

// Or connect with passthrough (no transformation)
const passthroughClient = await client.realtime.connect(stream, {
  model,
  onRemoteStream: (transformedStream) => {
    videoElement.srcObject = transformedStream;
  },
  initialState: {
    prompt: null  // passthrough mode
  }
});

// Disconnect when done
realtimeClient.disconnect();
```

### Async Processing (Queue API)

For video generation jobs, use the queue API to submit jobs and poll for results:

```typescript
import { createDecartClient, models } from "@decartai/sdk";

const client = createDecartClient({
  apiKey: "your-api-key-here"
});

// Submit and poll automatically
const result = await client.queue.submitAndPoll({
  model: models.video("lucy-pro-t2v"),
  prompt: "A cat playing piano",
  onStatusChange: (job) => {
    console.log(`Status: ${job.status}`);
  }
});

if (result.status === "completed") {
  videoElement.src = URL.createObjectURL(result.data);
} else {
  console.error("Job failed:", result.error);
}
```

Or manage the polling manually:

```typescript
// Submit the job
const job = await client.queue.submit({
  model: models.video("lucy-pro-t2v"),
  prompt: "A cat playing piano"
});
console.log(`Job ID: ${job.job_id}`);

// Poll for status
const status = await client.queue.status(job.job_id);
console.log(`Status: ${status.status}`);

// Get result when completed
if (status.status === "completed") {
  const blob = await client.queue.result(job.job_id);
  videoElement.src = URL.createObjectURL(blob);
}
```

## Development

### Setup

```bash
pnpm install
```

### Development Commands

- `pnpm build` - Build the project
- `pnpm dev:example` - Run Vite dev server for examples
- `pnpm test` - Run unit tests
- `pnpm test:e2e` - Run end-to-end tests
- `pnpm typecheck` - Type check with TypeScript
- `pnpm format` - Format code with Biome
- `pnpm lint` - Lint code with Biome

### Publishing

1. **Version bump**: Run `pnpm release` to bump the version (this uses `bumpp` to create a new version tag) and push it to GitHub
2. **Automated publish**: The GitHub Actions workflow will:
   - Build the project
   - Publish to npm
   - Create a GitHub release with changelog

The package is published to npm as `@decartai/sdk`.

## License

MIT
