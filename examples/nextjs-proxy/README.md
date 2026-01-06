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

