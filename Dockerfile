FROM node:20-alpine

# Deployment image for sdk.stage-decart.com.
#
# The API repo keeps a separate local-dev Dockerfile that clones SDK branches for
# `just build sdk`. This Dockerfile is intentionally built from the checked-out
# SDK repo so the image tag maps directly to an SDK commit.

RUN npm install -g pnpm@10.7.1

WORKDIR /app

COPY pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages ./packages
COPY examples ./examples

# SDK example target API domain. Keep the replacement scheme-free because the
# SDK source already includes the protocol in the default realtime URL.
ARG API_DOMAIN=api.stage-decart.com
RUN sed -i "s|api3.decart.ai|${API_DOMAIN}|g" packages/sdk/src/index.ts

RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

WORKDIR /app/packages/sdk
RUN pnpm build

RUN echo 'import { defineConfig } from "vite"; \
export default defineConfig({ \
  server: { \
    allowedHosts: ["sdk.decart.local", "sdk.stage-decart.com"], \
  }, \
});' > vite.config.ts

EXPOSE 3000

CMD ["pnpm", "dev:example", "--host", "0.0.0.0"]
