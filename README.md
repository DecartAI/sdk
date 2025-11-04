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

// Disconnect when done
realtimeClient.disconnect();
```

### Process Files

```typescript
import { createDecartClient, models } from "@decartai/sdk";

const client = createDecartClient({
  apiKey: "your-api-key-here"
});

// Process a video file
const file = fileInput.files[0];
const result = await client.process({
  model: models.video("lucy-pro-v2v"),
  prompt: "Lego World",
  data: file
});

videoElement.src = URL.createObjectURL(result);
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
