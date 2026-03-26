# Hono Edge Example

A Cloudflare Workers API using Hono demonstrating image and video editing.

## Setup

1. Install dependencies from the repo root:

```sh
cd ../..
pnpm install
pnpm build
```

2. Set your API key as a secret:

```sh
cd examples/hono-edge
npx wrangler secret put DECART_API_KEY
```

For local development, create a `.dev.vars` file:

```sh
echo "DECART_API_KEY=your-api-key-here" > .dev.vars
```

3. Start the development server:

```sh
pnpm dev
```

## Deploy

```sh
pnpm deploy
```

## Endpoints

These editing endpoints expect `imageDataUrl` / `videoDataUrl` fields containing base64 `data:` URLs.

### Image Editing

```bash
curl -X POST http://localhost:8787/api/image/generate \
  -H "Content-Type: application/json" \
  -d '{"prompt": "A beautiful sunset over mountains", "imageDataUrl": "data:image/png;base64,<base64-image>"}' \
  --output image.png
```

### Video Editing

```bash
curl -X POST http://localhost:8787/api/video/generate \
  -H "Content-Type: application/json" \
  -d '{"prompt": "A cat playing piano", "videoDataUrl": "data:video/mp4;base64,<base64-video>"}'
# Returns: {"jobId": "abc123", "status": "pending"}

curl http://localhost:8787/api/video/status/abc123
# Returns: {"job_id": "abc123", "status": "processing"}

curl http://localhost:8787/api/video/result/abc123 --output video.mp4
```

## API Reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/image/generate` | POST | Edit image from base64 data URL + prompt |
| `/api/video/generate` | POST | Submit video editing job |
| `/api/video/status/:id` | GET | Check video job status |
| `/api/video/result/:id` | GET | Get completed video |
