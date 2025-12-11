# Hono Edge Example

A Cloudflare Workers API using Hono demonstrating text-to-image and text-to-video generation.

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

### Text-to-Image

```bash
curl -X POST http://localhost:8787/api/image/generate \
  -H "Content-Type: application/json" \
  -d '{"prompt": "A beautiful sunset over mountains"}' \
  --output image.png
```

### Text-to-Video

```bash
# Submit video job
curl -X POST http://localhost:8787/api/video/generate \
  -H "Content-Type: application/json" \
  -d '{"prompt": "A cat playing piano"}'
# Returns: {"jobId": "abc123", "status": "pending"}

# Check status
curl http://localhost:8787/api/video/status/abc123
# Returns: {"job_id": "abc123", "status": "processing"}

# Get result (when completed)
curl http://localhost:8787/api/video/result/abc123 --output video.mp4
```

## API Reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/image/generate` | POST | Generate image from text |
| `/api/video/generate` | POST | Submit video generation job |
| `/api/video/status/:id` | GET | Check video job status |
| `/api/video/result/:id` | GET | Get completed video |
