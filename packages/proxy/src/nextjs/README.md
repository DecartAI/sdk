# Decart Next.js Proxy Middleware

> [!IMPORTANT]  
> Before setting up the proxy, ensure you have `DECART_API_KEY` set as an environment variable.

## Next.js App Router (Recommended)

Create a route handler at `app/api/decart/[...path]/route.ts`:

```typescript
import { route } from "@decartai/proxy/nextjs";

const { GET, POST, PUT } = route();

export { GET, POST, PUT };
```

Or with custom options:

```typescript
import { route } from "@decartai/proxy/nextjs";

const { GET, POST, PUT } = route({
  apiKey: process.env.DECART_API_KEY, // Optional, defaults to env var
  baseUrl: "https://api.decart.ai", // Optional, defaults to api.decart.ai
  integration: "my-app", // Optional integration identifier
});

export { GET, POST, PUT };
```

Alternatively, you can use the handler directly:

```typescript
import { decartProxyAppRouter } from "@decartai/proxy/nextjs";

const handler = decartProxyAppRouter();

export const GET = handler;
export const POST = handler;
export const PUT = handler;
```

## Next.js Pages Router

Create an API route at `pages/api/decart/[...path].ts`:

```typescript
import decartProxyNextjs from "@decartai/proxy/nextjs";

export default decartProxyNextjs();
```

Or with custom options:

```typescript
import { decartProxyPagesRouter } from "@decartai/proxy/nextjs";

export default decartProxyPagesRouter({
  apiKey: process.env.DECART_API_KEY, // Optional, defaults to env var
  baseUrl: "https://api.decart.ai", // Optional, defaults to api.decart.ai
  integration: "my-app", // Optional integration identifier
});
```

## Client-Side Usage

Then use the SDK on the client side:

```typescript
import { createDecartClient, models } from "@decartai/sdk";

const client = createDecartClient({ proxy: "/api/decart" });

// Use the client as normal
const result = await client.process({
  model: models.image("lucy-pro-t2i"),
  prompt: "A beautiful sunset",
});
```

