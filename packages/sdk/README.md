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

> **Note**: We've improved the SDK API! Check out the [new simplified API](#new-api) below. The old API still works but is deprecated.

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

## New API

We've redesigned the SDK API for better clarity and consistency! The new API provides:

- **Clearer method names**: `generate()` instead of `process()`, `submitAndWait()` instead of `submitAndPoll()`
- **Flatter structure**: No more `queue.` prefix for async operations
- **Better naming**: `onProgress` instead of `onStatusChange`, `getJobStatus()` instead of `status()`
- **Type safety**: Works with any model that supports the operation

### Synchronous Generation

```typescript
import { createDecartClient, models } from "@decartai/sdk";

const client = createDecartClient({
  apiKey: "your-api-key-here"
});

// Generate an image synchronously
const blob = await client.generate({
  model: models.image("lucy-pro-t2i"),
  prompt: "A beautiful sunset over the ocean"
});
```

### Async Generation with Auto-Polling

```typescript
// Submit and wait for completion
const result = await client.submitAndWait({
  model: models.video("lucy-pro-t2v"),
  prompt: "A cat playing piano",
  onProgress: (job) => {
    console.log(`Job ${job.job_id}: ${job.status}`);
  }
});

if (result.status === "completed") {
  videoElement.src = URL.createObjectURL(result.data);
} else {
  console.error("Job failed:", result.error);
}
```

### Manual Job Management

```typescript
// Submit the job
const job = await client.submit({
  model: models.video("lucy-pro-t2v"),
  prompt: "A cat playing piano"
});
console.log(`Job ID: ${job.job_id}`);

// Poll for status
const status = await client.getJobStatus(job.job_id);
console.log(`Status: ${status.status}`);

// Get result when completed
if (status.status === "completed") {
  const blob = await client.getJobResult(job.job_id);
  videoElement.src = URL.createObjectURL(blob);
}
```

### Migration from Old API

| Old API | New API |
|---------|---------|
| `client.process()` | `client.generate()` |
| `client.queue.submit()` | `client.submit()` |
| `client.queue.submitAndPoll()` | `client.submitAndWait()` |
| `client.queue.status()` | `client.getJobStatus()` |
| `client.queue.result()` | `client.getJobResult()` |
| `onStatusChange` callback | `onProgress` callback |

The old API still works but is deprecated and will be removed in a future major version.

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
