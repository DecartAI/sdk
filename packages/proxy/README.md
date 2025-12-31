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

You can also create your own custom integration. See docs here.


## Supported Endpoints

The proxy supports all model endpoints, apart from the realtime models.

## How It Works

1. Client SDK makes a request to your proxy endpoint (e.g., `/api/decart/v1/generate/lucy-pro-t2i`)
2. Proxy middleware intercepts the request
3. Proxy attaches your server's API key to the request
4. Proxy forwards the request to `https://api.decart.ai`
5. Proxy returns the response to the client


