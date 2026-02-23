# @decartai/proxy

Server-side proxy integration for Decart SDK. Allows you to use the Decart SDK on the client side while keeping your API key secure on the server.

## Installation

```bash
npm install @decartai/proxy
# or
pnpm add @decartai/proxy
# or
yarn add @decartai/proxy
```

## Integrations

We offer built in integrations for the following libraries:
- [Express](./src/express/README.md)
- [Next.js](./src/nextjs/README.md)

You can also [create your own custom adapter](#custom-adapters).


## Supported Endpoints

The proxy supports all model endpoints, apart from the realtime models.

## How It Works

1. Client SDK makes a request to your proxy endpoint (e.g., `/api/decart/v1/generate/lucy-pro-t2i`)
2. Proxy middleware intercepts the request
3. Proxy attaches your server's API key to the request
4. Proxy forwards the request to `https://api.decart.ai`
5. Proxy returns the response to the client

## Custom Adapters

You can create a proxy adapter for any HTTP framework by implementing the `ProxyBehavior` interface with the framework specific implementation, and passing it to `handleRequest()`.

### Example: Fastify Adapter

```typescript
import {
  handleRequest,
  type DecartProxyOptions,
  type ProxyBehavior,
} from "@decartai/proxy";
import type { FastifyRequest, FastifyReply } from "fastify";

export function createDecartProxy(options?: DecartProxyOptions) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const behavior: ProxyBehavior = {
      integration: "fastify",
      baseUrl: options?.baseUrl,
      method: request.method,
      getHeaders: () => request.headers as Record<string, string>,
      getHeader: (name) => request.headers[name],
      getRequestBody: async () => JSON.stringify(request.body),
      sendHeader: (name, value) => reply.header(name, value),
      respondWith: (status, data) => reply.status(status).send(data),
      getRequestPath: () => request.url,
      sendResponse: async (response) => {
        reply.status(response.status).send(response.body);
      },
    };

    await handleRequest(behavior);
  };
}
```
