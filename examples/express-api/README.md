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

These editing endpoints expect `imageDataUrl` / `videoDataUrl` fields containing base64 `data:` URLs. This keeps the example self-contained and avoids server-side fetching of arbitrary remote URLs.

### Image Editing

```bash
curl -X POST http://localhost:3000/api/image/edit \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Oil painting style", "imageDataUrl": "data:image/png;base64,<base64-image>"}' \
  --output image.png
```

### Video Editing

```bash
curl -X POST http://localhost:3000/api/video/generate \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Make it look like a watercolor painting", "videoDataUrl": "data:video/mp4;base64,<base64-video>"}'
# Returns: {"jobId": "abc123", "status": "pending"}

curl http://localhost:3000/api/video/status/abc123
# Returns: {"job_id": "abc123", "status": "processing"}

curl http://localhost:3000/api/video/result/abc123 --output video.mp4

curl -X POST http://localhost:3000/api/video/generate-sync \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Transform into anime style", "videoDataUrl": "data:video/mp4;base64,<base64-video>"}' \
  --output video.mp4
```

## API Reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/image/edit` | POST | Edit image from base64 data URL + prompt |
| `/api/video/generate` | POST | Submit video editing job |
| `/api/video/status/:id` | GET | Check video job status |
| `/api/video/result/:id` | GET | Get completed video |
| `/api/video/generate-sync` | POST | Edit video (waits for completion) |
