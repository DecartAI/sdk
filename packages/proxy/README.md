# @decartai/proxy

Server-side proxy middleware for Decart SDK. This package allows you to use the Decart SDK on the client side while keeping your API key secure on the server.

## Installation

```bash
npm install @decartai/proxy
# or
pnpm add @decartai/proxy
# or
yarn add @decartai/proxy
```

## Quick Start

### Express

```typescript
import express from "express";
import { decartProxy } from "@decartai/proxy/express";

const app = express();

// Mount the proxy middleware
app.use("/api/decart", decartProxy()

app.listen(3000);
```

### Next.js

Create a catch-all API route at `app/api/decart/[...path]/route.ts`:

```typescript
import { createDecartProxyHandler } from "@decartai/proxy/nextjs";

export const { GET, POST } = createDecartProxyHandler({
  apiKey: process.env.DECART_API_KEY!,
});
```

Then use the SDK on the client side:

```typescript
import { createDecartClient, models } from "@decartai/sdk";

const client = createDecartClient({
  proxy: "/api/decart", // No API key needed!
});

// Use the client as normal
const result = await client.process({
  model: models.image("lucy-pro-t2i"),
  prompt: "A beautiful sunset",
});
```

## API Reference

### `decartProxy(options)`

Express middleware factory function.

**Parameters:**
- `options.apiKey` (required): Your Decart API key
- `options.baseUrl` (optional): Override the default API base URL. Defaults to `"https://api.decart.ai"`
- `options.integration` (optional): Integration identifier for User-Agent header

**Returns:** Express middleware function

### `createDecartProxyHandler(options)`

Next.js API route handler factory function.

**Parameters:**
- `options.apiKey` (required): Your Decart API key
- `options.baseUrl` (optional): Override the default API base URL. Defaults to `"https://api.decart.ai"`
- `options.integration` (optional): Integration identifier for User-Agent header

**Returns:** Object with `GET` and `POST` handlers compatible with Next.js App Router

## Supported Endpoints

The proxy supports all HTTP endpoints:

- **Process API**: `POST /v1/generate/{model}` - Synchronous image generation
- **Queue API**: 
  - `POST /v1/jobs/{model}` - Submit async video generation job
  - `GET /v1/jobs/{jobId}` - Get job status
  - `GET /v1/jobs/{jobId}/content` - Get job result
- **Tokens API**: `POST /v1/client/tokens` - Create client tokens

**Note:** The realtime WebRTC API is not supported through the proxy and requires direct API access.

## Security Best Practices

1. **Never expose your API key**: Always keep your API key in environment variables on the server
2. **Use HTTPS**: Always use HTTPS in production to encrypt traffic between client and proxy
3. **Rate limiting**: Consider adding rate limiting to your proxy endpoints
4. **CORS**: Configure CORS appropriately if your client runs on a different origin
5. **Authentication**: Add authentication/authorization to your proxy endpoints if needed

## Examples

### Express with CORS

```typescript
import express from "express";
import cors from "cors";
import { decartProxy } from "@decartai/proxy/express";

const app = express();

app.use(cors({
  origin: process.env.CLIENT_URL,
}));

app.use("/api/decart", decartProxy({
  apiKey: process.env.DECART_API_KEY!,
  integration: "my-app/1.0.0",
}));

app.listen(3000);
```

### Next.js with Environment Variables

```typescript
// app/api/decart/[...path]/route.ts
import { createDecartProxyHandler } from "@decartai/proxy/nextjs";

export const { GET, POST } = createDecartProxyHandler({
  apiKey: process.env.DECART_API_KEY!,
  integration: "my-nextjs-app/1.0.0",
});
```

### Client-side Usage

```typescript
// In your React/Vue/etc component
import { createDecartClient, models } from "@decartai/sdk";

function MyComponent() {
  const client = createDecartClient({
    proxy: "/api/decart", // Points to your proxy
  });

  const generateImage = async () => {
    const blob = await client.process({
      model: models.image("lucy-pro-t2i"),
      prompt: "A cat playing piano",
    });
    
    const url = URL.createObjectURL(blob);
    // Use the image URL
  };

  return <button onClick={generateImage}>Generate</button>;
}
```

## How It Works

1. Client SDK makes a request to your proxy endpoint (e.g., `/api/decart/v1/generate/lucy-pro-t2i`)
2. Proxy middleware intercepts the request
3. Proxy attaches your server's API key to the request
4. Proxy forwards the request to `https://api.decart.ai`
5. Proxy returns the response to the client

The client never sees or needs your API key!

## License

MIT

