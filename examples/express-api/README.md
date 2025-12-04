# Express API Example

An Express server demonstrating the Decart SDK's Process and Queue APIs.

## Setup

1. Copy `.env.example` to `.env` and add your API key:

```sh
cp .env.example .env
```

2. Install dependencies from the repo root:

```sh
cd ../..
pnpm install
pnpm build
```

3. Start the development server:

```sh
cd examples/express-api
pnpm dev
```

## Endpoints

### Image Generation

```bash
# Text-to-image
curl -X POST http://localhost:3000/api/image/generate \
  -H "Content-Type: application/json" \
  -d '{"prompt": "A beautiful sunset over mountains"}' \
  --output image.png

# Image-to-image
curl -X POST http://localhost:3000/api/image/transform \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Oil painting style", "imageUrl": "https://example.com/image.jpg"}' \
  --output transformed.png
```

### Video Generation

```bash
# Submit video job
curl -X POST http://localhost:3000/api/video/generate \
  -H "Content-Type: application/json" \
  -d '{"prompt": "A cat playing piano"}'
# Returns: {"jobId": "abc123", "status": "pending"}

# Check status
curl http://localhost:3000/api/video/status/abc123
# Returns: {"job_id": "abc123", "status": "processing"}

# Get result (when completed)
curl http://localhost:3000/api/video/result/abc123 --output video.mp4

# Or use the sync endpoint (waits for completion)
curl -X POST http://localhost:3000/api/video/generate-sync \
  -H "Content-Type: application/json" \
  -d '{"prompt": "A timelapse of clouds moving"}' \
  --output video.mp4
```

## API Reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/image/generate` | POST | Generate image from text |
| `/api/image/transform` | POST | Transform image with prompt |
| `/api/video/generate` | POST | Submit video generation job |
| `/api/video/status/:id` | GET | Check video job status |
| `/api/video/result/:id` | GET | Get completed video |
| `/api/video/generate-sync` | POST | Generate video (waits for completion) |
