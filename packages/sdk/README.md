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
**[https://docs.platform.decart.ai/sdks/javascript](https://docs.platform.decart.ai/sdks/javascript)**

## Quick Start

### Real-time Video Transformation

Realtime connections are LiveKit-backed in the SDK. Existing client usage stays the same: provide a
camera `MediaStream`, choose a realtime model, and handle the transformed remote stream.

```typescript
import { createDecartClient, models } from "@decartai/sdk";

const model = models.realtime("lucy-restyle-2");

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

#### Front-camera mirroring

Pre-flip the input stream:

```ts
const realtimeClient = await client.realtime.connect(stream, {
  model,
  mirror: "auto", // or true to always mirror
  // ...
});
```

Options:
- `false` (default) — never mirror.
- `"auto"` — mirror when the input track reports `facingMode: "user"` (mobile front cameras).
- `true` — always mirror (e.g. desktop webcams).

### Watch a Stream

A connected realtime session exposes an SDK `subscribeToken` once it reaches a
connected state. Share that SDK token with viewers — `client.realtime.subscribe`
uses it to request receive-only LiveKit credentials from Decart, then connects to
the LiveKit room for the styled output stream. No viewer camera is required.

**Producer** — capture the token from the active session:

```typescript
const realtimeClient = await client.realtime.connect(stream, {
  model,
  onRemoteStream: (transformedStream) => {
    videoElement.srcObject = transformedStream;
  },
});

realtimeClient.on("connectionChange", (state) => {
  if ((state === "connected" || state === "generating") && realtimeClient.subscribeToken) {
    const subscribeToken = realtimeClient.subscribeToken;
    // Pass `subscribeToken` to the viewer snippet below.
  }
});
```

**Viewer** — attach to the producer's stream with the token:

```typescript
import { createDecartClient, type RealTimeSubscribeClient } from "@decartai/sdk";

const client = createDecartClient({ apiKey: "your-api-key-here" });

const subscriber: RealTimeSubscribeClient = await client.realtime.subscribe({
  token: subscribeToken,
  onRemoteStream: (stream) => {
    videoElement.srcObject = stream;
  },
});

subscriber.on("connectionChange", (state) => {
  console.log(`Viewer state: ${state}`);
});

// Disconnect when done
subscriber.disconnect();
```

### Connection quality

There are two layers: a **preflight** check before connecting, and an **in-session** quality
signal while connected. Both report on a shared `"good" | "fair" | "poor" | "critical"` scale —
the SDK reports, you decide what to do (gate the UI, warn the user, etc.).

**Preflight (before connecting).** A fast, network-only reachability check — it spins up a
throwaway peer connection against public STUN, so there's no session and no cost:

```typescript
const { quality, metrics, reasons } = await client.realtime.checkConnectivity();
// metrics: { transport: "udp" | "relay" | "failed", rttMs }
if (quality === "critical") showFallbackUI(reasons);
```

**In-session quality.** While connected, the SDK derives a smoothed verdict from WebRTC stats
(latency, packet loss, bandwidth headroom, frame rate) and tells you which dimension is the
bottleneck:

```typescript
const realtimeClient = await client.realtime.connect(stream, {
  model,
  onRemoteStream: (s) => { videoElement.srcObject = s; },
  onConnectionQuality: ({ quality, limitingFactor, metrics }) => {
    // limitingFactor: "bandwidth" | "latency" | "loss" | "stall" | "cpu" | "none"
    // metrics: { rttMs, fps, packetLoss, upstreamJitterMs, availableUpstreamKbps, ... }
    console.log(quality, limitingFactor);
  },
});

// also available as an event and a getter:
realtimeClient.on("connectionQuality", (report) => { /* ... */ });
realtimeClient.getConnectionQuality(); // latest report, or null before the first sample
```

**Glass-to-glass latency (opt-in, diagnostic).** Network RTT hides the dominant cost in
real-time video — model inference — so a session can read "good" while actually feeling laggy.
Set `debugQuality: true` to measure the *real* camera→display latency. The SDK attaches a capture
timestamp using LiveKit frame metadata; the server propagates it through inference and the SDK
matches it to output playout. This surfaces **startup** (`ttffMs`) and **steady-state**
(`g2gMs`) latency. When present, glass-to-glass drives the latency verdict instead of RTT.

> Frame metadata is currently experimental in LiveKit and requires encoded-transform support.
> It does not alter visible pixels. `g2gDropRatio` remains `null` until frame IDs are propagated
> through the server pipeline as well as timestamps.

```typescript
const realtimeClient = await client.realtime.connect(stream, {
  model,
  debugQuality: true,
  onConnectionQuality: ({ quality, metrics }) => {
    console.log(metrics.ttffMs, metrics.g2gMs, metrics.g2gDropRatio);
  },
});
```

For a *measured* verdict before connecting (instead of the network-only check), use the **deep
probe**: it briefly opens a real session with a synthetic source, measures glass-to-glass, then
tears it down. It requires a `model` and costs a short GPU session:

```typescript
const probe = await client.realtime.checkConnectivity({ deep: true, model });
console.log(probe.quality, probe.metrics.g2gMs, probe.metrics.ttffMs);
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
  model: models.video("lucy-pro-v2v"),
  prompt: "Make it look like a watercolor painting",
  data: videoFile,
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
  model: models.video("lucy-pro-v2v"),
  prompt: "Make it look like a watercolor painting",
  data: videoFile
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

### React Native / Expo

React Native realtime requires [LiveKit's React Native packages](https://github.com/livekit/client-sdk-react-native)
and an early `registerGlobals()` call. Plain `react-native-webrtc` is not
supported. SDK imports and `createDecartClient(...)` usage stay the same.

```sh
npm install @decartai/sdk livekit-client@2.20.1 \
  @livekit/react-native@2.11.1 \
  @livekit/react-native-webrtc@144.1.1
```

Call LiveKit setup from a side-effect module that runs before your router or app
entrypoint:

```ts
// livekit-bootstrap.ts
import { registerGlobals } from "@livekit/react-native";

registerGlobals();
```

```ts
// index.ts
import "./livekit-bootstrap";
import "expo-router/entry"; // or import your root App component
```

With the globals registered, realtime usage is the same as on the web. Use the
model's numeric FPS when configuring native camera capture, then pass that
`MediaStream` to the SDK:

```ts
import { createDecartClient, models, resolveFpsNumber } from "@decartai/sdk";
import { mediaDevices } from "@livekit/react-native-webrtc";

const client = createDecartClient({ apiKey: "your-api-key-here" });
const model = models.realtime("lucy-2.5");
const captureFps = resolveFpsNumber(model.fps);

const cameraStream = await mediaDevices.getUserMedia({
  audio: false,
  video: {
    facingMode: "user",
    frameRate: captureFps,
    width: model.width,
    height: model.height,
  },
});

const realtimeClient = await client.realtime.connect(cameraStream, {
  model,
  preferredVideoCodec: "vp8",
  onRemoteStream,
});
```

For Expo, install the config plugins:

```sh
npm install @livekit/react-native-expo-plugin@1.0.2 \
  @config-plugins/react-native-webrtc
```

Add them to `app.json`:

```json
{
  "expo": {
    "plugins": [
      "@livekit/react-native-expo-plugin",
      "@config-plugins/react-native-webrtc"
    ]
  }
}
```

Run `npx expo prebuild` and rebuild the native app. LiveKit does not run in Expo
Go. Bare React Native apps must follow LiveKit's native setup instructions.

Outgoing `mirror`, `debugQuality`, and deep connectivity preflight are browser-only
and fail with `UNSUPPORTED_PLATFORM_FEATURE` on React Native. Mirror the local
preview with your native video view instead.

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
