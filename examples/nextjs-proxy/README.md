# Next.js Proxy Example

A simple Next.js app demonstrating the Decart SDK with proxy middleware.

## Setup

1. Install dependencies and build packages from the repo root:

```sh
cd ../..
pnpm install
pnpm build
```

2. Create a `.env.local` file in this directory:

```sh
cd examples/nextjs-proxy
echo "DECART_API_KEY=your-api-key-here" > .env.local
```

3. Start the development server:

```sh
pnpm dev
```

The app will be available at `http://localhost:3000`.

## How It Works

### Server Side (`app/api/decart/[...path]/route.ts`)

The Next.js App Router route handler uses the proxy middleware to forward requests to Decart's API:

```typescript
import { route } from "@decartai/proxy/nextjs";

const { GET, POST } = route();

export { GET, POST };
```

All requests to `/api/decart/*` are automatically proxied to `api.decart.ai` with your API key attached.

### Client Side (`app/page.tsx`)

The frontend uses the SDK pointing to the proxy endpoint:

```typescript
import { PROXY_ROUTE } from "@decartai/proxy/nextjs";
import { createDecartClient, models } from "@decartai/sdk";

const client = createDecartClient({
  proxy: PROXY_ROUTE, // "/api/decart"
});

const blob = await client.process({
  model: models.image("lucy-pro-t2i"),
  prompt: "A beautiful sunset",
});
```

## Features

- ✅ **Secure**: API key never leaves the server
- ✅ **Simple**: Client code is identical to direct SDK usage
- ✅ **Type-safe**: Full TypeScript support
- ✅ **Next.js App Router**: Uses the latest Next.js routing

## Architecture

```
Browser (SDK) → Next.js API Route (Proxy) → api.decart.ai
              (no API key)                  (API key attached)
```

The client-side SDK makes requests to your Next.js API route, which securely attaches your API key and forwards them to Decart's API.

## Security Notes

- Your `DECART_API_KEY` is stored in `.env.local` (gitignored)
- The API key is only used server-side in the proxy middleware
- Client-side code never sees or needs the API key
- All requests go through your proxy, giving you full control

