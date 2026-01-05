# Express Proxy Example

This example demonstrates how to use `@decartai/proxy` with Express to enable client-side SDK usage without exposing your API key.

## Architecture

```
Browser (SDK) → Express Server (Proxy) → api.decart.ai
              (no API key)              (API key attached)
```

The client-side SDK makes requests to your Express server, which securely attaches your API key and forwards them to Decart's API.

## Setup

1. Install dependencies and build packages from the repo root:

```sh
cd ../..
pnpm install
pnpm build
```

2. Create a `.env` file in this directory:

```sh
cd examples/express-proxy
echo "DECART_API_KEY=your-api-key-here" > .env
```

3. Start the server:

```sh
pnpm dev
```

The server will start at `http://localhost:3000`. Open it in your browser to see the example.

**Note**: Make sure to run `pnpm build` from the repo root first, as the example serves the SDK from the built `dist` directory.

## How It Works

### Server Side (`src/server.ts`)

The Express server:
1. Serves static files from the `public` directory
2. Mounts the Decart proxy middleware at `/api/decart`
3. The proxy intercepts requests and forwards them to `api.decart.ai` with your API key

```typescript
import { handler, route } from "@decartai/proxy/express";

app.use(route, handler({
  apiKey: process.env.DECART_API_KEY!,
}));
```

### Client Side (`public/index.html`)

The frontend:
1. Loads the Decart SDK from CDN
2. Creates a client pointing to the proxy endpoint
3. Uses the SDK normally - no API key needed!

```javascript
import { createDecartClient, models } from '@decartai/sdk';

const client = createDecartClient({
  proxy: '/api/decart', // Points to your Express proxy
});

const blob = await client.process({
  model: models.image('lucy-pro-t2i'),
  prompt: 'A beautiful sunset',
});
```

## Features

- ✅ **Secure**: API key never leaves the server
- ✅ **Simple**: Client code is identical to direct SDK usage
- ✅ **Type-safe**: Full TypeScript support
- ✅ **No build step**: Uses ES modules and CDN for easy setup

## Testing

1. Start the server: `pnpm dev`
2. Open `http://localhost:3000` in your browser
3. Enter a prompt and click "Generate Image"
4. The image will be generated through the proxy

## Security Notes

- Your `DECART_API_KEY` is stored in `.env` (gitignored)
- The API key is only used server-side in the proxy middleware
- Client-side code never sees or needs the API key
- All requests go through your proxy, giving you full control
