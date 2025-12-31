# Decart Next.js Proxy Route

> [!IMPORTANT]  
> Before setting up the proxy, ensure you have `DECART_API_KEY` set as an environment variable.

## Next.js App Router (Recommended)

Create a route handler at `app/api/decart/[...path]/route.ts`:

```typescript
import { route } from "@decartai/proxy/nextjs";
export const { GET, POST } = route();
```

## Next.js Pages Router

Create an API route at `pages/api/decart/[...path].ts`:

```typescript
import decartProxyNextjs from "@decartai/proxy/nextjs";
export default decartProxyNextjs();
```

## Client-Side Usage

Then use the SDK on the client side:

```typescript
import { createDecartClient, models, PROXY_ROUTE } from "@decartai/sdk";

const client = createDecartClient({ proxy: PROXY_ROUTE });

// Use the client as normal
const result = await client.process({
  model: models.image("lucy-pro-t2i"),
  prompt: "A beautiful sunset",
});
```

